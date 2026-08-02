//! Safe, nested Markdown projection designed to be usable as an Obsidian vault.

use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::{mpsc, Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use atomicwrites::{AllowOverwrite, AtomicFile};
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use storm_core::{CoreError, Folder, Note, NotebookCrdt, NotebookSeed, NotebookSnapshot};
use thiserror::Error;
use uuid::Uuid;
use walkdir::{DirEntry, WalkDir};

pub const STATE_DIRECTORY: &str = ".stormdance";
pub const CONFIG_FILE: &str = "config.json";
pub const STATE_FILE: &str = "state.bin";
pub const MANIFEST_FILE: &str = "manifest.json";
pub const MIRROR_SCHEMA: u32 = 2;
const METADATA_PREFIX: &str = "<!-- stormdance:";
const METADATA_SUFFIX: &str = " -->";
const MAX_CONFIG_BYTES: u64 = 64 * 1024;
const MAX_MARKDOWN_BYTES: u64 = 16 * 1024 * 1024;
const MAX_STATE_BYTES: u64 = MAX_MARKDOWN_BYTES * 4;
const MAX_MANIFEST_BYTES: u64 = MAX_CONFIG_BYTES * 16;
const MAX_SAFE_TIMESTAMP: u64 = 9_007_199_254_740_991;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("I/O error at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("invalid linked directory: {0}")]
    InvalidRoot(String),
    #[error("unsafe relative path: {0}")]
    UnsafePath(String),
    #[error("invalid storm.dance metadata: {0}")]
    InvalidMetadata(String),
    #[error("invalid link configuration: {0}")]
    InvalidConfig(String),
    #[error("invalid mirror manifest: {0}")]
    InvalidManifest(String),
    #[error("directory is not linked to a storm.dance notebook")]
    NotLinked,
    #[error(transparent)]
    Core(#[from] CoreError),
    #[error("filesystem watcher failed: {0}")]
    Watch(#[from] notify::Error),
}

fn io(path: impl Into<PathBuf>, source: std::io::Error) -> StorageError {
    StorageError::Io {
        path: path.into(),
        source,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Environment {
    Dev,
    Production,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkConfig {
    pub schema: u32,
    pub notebook_id: String,
    pub conversation_id: String,
    pub notebook_name: String,
    pub profile: String,
    pub env: Environment,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_inbox_id: Option<String>,
}

impl LinkConfig {
    pub fn validate(&self) -> Result<(), StorageError> {
        if self.schema != 1 && self.schema != MIRROR_SCHEMA {
            return Err(StorageError::InvalidConfig(format!(
                "unsupported schema {}",
                self.schema
            )));
        }
        for (name, value) in [
            ("notebookId", self.notebook_id.as_str()),
            ("conversationId", self.conversation_id.as_str()),
            ("notebookName", self.notebook_name.as_str()),
            ("profile", self.profile.as_str()),
        ] {
            if value.trim().is_empty() || value.len() > 512 {
                return Err(StorageError::InvalidConfig(format!("invalid {name}")));
            }
        }
        if self
            .expected_inbox_id
            .as_deref()
            .is_some_and(|value| value.is_empty() || value.len() > 512)
        {
            return Err(StorageError::InvalidConfig(
                "invalid expectedInboxId".to_owned(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestEntry {
    pub path: String,
    pub hash: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub schema: u32,
    pub notes: BTreeMap<String, ManifestEntry>,
    #[serde(default)]
    pub folders: BTreeMap<String, String>,
}

impl Default for Manifest {
    fn default() -> Self {
        Self {
            schema: MIRROR_SCHEMA,
            notes: BTreeMap::new(),
            folders: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Metadata {
    schema: u32,
    notebook_id: String,
    note_id: String,
    folder_id: Option<String>,
    created_at: u64,
    updated_at: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ScanResult {
    pub folder_upserts: Vec<Folder>,
    pub deleted_folder_ids: Vec<String>,
    pub folder_witnesses: BTreeMap<String, FolderScanWitness>,
    pub upserts: Vec<Note>,
    pub deleted_note_ids: Vec<String>,
    pub ignored_paths: Vec<String>,
    pub preferred_paths: BTreeMap<String, String>,
    pub witnesses: BTreeMap<String, ScanWitness>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FolderScanWitness {
    pub path: String,
    pub exists: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScanWitness {
    pub path: String,
    pub hash: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MaterializeResult {
    pub written_paths: Vec<String>,
    pub removed_paths: Vec<String>,
    pub protected_paths: Vec<String>,
    pub conflict_paths: Vec<String>,
    pub manifest: Manifest,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorStatus {
    pub root: PathBuf,
    pub linked: bool,
    pub notebook_id: Option<String>,
    pub conversation_id: Option<String>,
    pub expected_inbox_id: Option<String>,
    pub tracked_notes: usize,
    pub markdown_files: usize,
    pub pending_local_changes: usize,
    pub ignored_paths: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReconcileResult {
    pub snapshot: NotebookSnapshot,
    pub scan: ScanResult,
    pub materialized: MaterializeResult,
    pub update: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MirrorEvent {
    External(Vec<PathBuf>),
    SelfWrite(Vec<PathBuf>),
    Error(String),
}

#[derive(Clone)]
pub struct Mirror {
    root: PathBuf,
    self_hashes: Arc<Mutex<HashMap<PathBuf, String>>>,
}

impl std::fmt::Debug for Mirror {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Mirror")
            .field("root", &self.root)
            .finish_non_exhaustive()
    }
}

impl Mirror {
    pub fn create(root: impl AsRef<Path>) -> Result<Self, StorageError> {
        let root = root.as_ref();
        fs::create_dir_all(root).map_err(|error| io(root, error))?;
        Self::open(root)
    }

    pub fn open(root: impl AsRef<Path>) -> Result<Self, StorageError> {
        let root = root.as_ref();
        let metadata = fs::symlink_metadata(root).map_err(|error| io(root, error))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(StorageError::InvalidRoot(
                "path must be a real directory, not a symlink".to_owned(),
            ));
        }
        let root = fs::canonicalize(root).map_err(|error| io(root, error))?;
        Ok(Self {
            root,
            self_hashes: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn state_directory(&self) -> PathBuf {
        self.root.join(STATE_DIRECTORY)
    }

    fn ensure_state_directory(&self) -> Result<PathBuf, StorageError> {
        let path = self.state_directory();
        if let Ok(metadata) = fs::symlink_metadata(&path) {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(StorageError::InvalidRoot(
                    ".stormdance must be a real directory".to_owned(),
                ));
            }
        } else {
            fs::create_dir(&path).map_err(|error| io(&path, error))?;
        }
        Ok(path)
    }

    pub fn read_link(&self) -> Result<LinkConfig, StorageError> {
        let path = self.state_directory().join(CONFIG_FILE);
        let source = read_regular_limited_inside(&self.root, &path, MAX_CONFIG_BYTES)?
            .ok_or(StorageError::NotLinked)?;
        let config: LinkConfig = serde_json::from_slice(&source)
            .map_err(|error| StorageError::InvalidConfig(error.to_string()))?;
        config.validate()?;
        Ok(config)
    }

    pub fn write_link(&self, config: &LinkConfig) -> Result<(), StorageError> {
        config.validate()?;
        self.ensure_state_directory()?;
        if let Ok(existing) = self.read_link() {
            if existing.notebook_id != config.notebook_id
                || existing.conversation_id != config.conversation_id
                || existing.profile != config.profile
                || existing.env != config.env
            {
                return Err(StorageError::InvalidConfig(
                    "directory is already linked to a different notebook, profile, or environment"
                        .to_owned(),
                ));
            }
        }
        let mut canonical = config.clone();
        canonical.schema = MIRROR_SCHEMA;
        let bytes = serde_json::to_vec_pretty(&canonical)
            .map_err(|error| StorageError::InvalidConfig(error.to_string()))?;
        if bytes.len() as u64 + 1 > MAX_CONFIG_BYTES {
            return Err(StorageError::InvalidConfig(
                "link configuration exceeds the size limit".to_owned(),
            ));
        }
        atomic_write(
            &self.state_directory().join(CONFIG_FILE),
            &with_newline(bytes),
            0o600,
        )
    }

    pub fn unlink(&self, remove_state: bool) -> Result<(), StorageError> {
        let config = self.state_directory().join(CONFIG_FILE);
        remove_regular_file_inside(&self.root, &config)?;
        if remove_state {
            for name in [STATE_FILE, MANIFEST_FILE] {
                remove_regular_file_inside(&self.root, &self.state_directory().join(name))?;
            }
        }
        Ok(())
    }

    pub fn read_state(&self) -> Result<Option<Vec<u8>>, StorageError> {
        read_regular_limited_inside(
            &self.root,
            &self.state_directory().join(STATE_FILE),
            MAX_STATE_BYTES,
        )
    }

    pub fn write_state(&self, state: &[u8]) -> Result<(), StorageError> {
        if state.len() as u64 > MAX_STATE_BYTES {
            return Err(StorageError::InvalidConfig(
                "CRDT state exceeds the size limit".to_owned(),
            ));
        }
        self.ensure_state_directory()?;
        atomic_write(&self.state_directory().join(STATE_FILE), state, 0o600)
    }

    pub fn read_manifest(&self) -> Result<Manifest, StorageError> {
        let path = self.state_directory().join(MANIFEST_FILE);
        let Some(bytes) = read_regular_limited_inside(&self.root, &path, MAX_MANIFEST_BYTES)?
        else {
            return Ok(Manifest::default());
        };
        let manifest: Manifest = serde_json::from_slice(&bytes)
            .map_err(|error| StorageError::InvalidManifest(error.to_string()))?;
        validate_manifest(manifest)
    }

    fn write_manifest(&self, manifest: &Manifest) -> Result<(), StorageError> {
        self.ensure_state_directory()?;
        let bytes = serde_json::to_vec_pretty(manifest)
            .map_err(|error| StorageError::InvalidManifest(error.to_string()))?;
        if bytes.len() as u64 + 1 > MAX_MANIFEST_BYTES {
            return Err(StorageError::InvalidManifest(
                "manifest exceeds the size limit".to_owned(),
            ));
        }
        atomic_write(
            &self.state_directory().join(MANIFEST_FILE),
            &with_newline(bytes),
            0o600,
        )
    }

    pub fn load_replica(&self) -> Result<NotebookCrdt, StorageError> {
        let config = self.read_link()?;
        match self.read_state()? {
            Some(update) => Ok(NotebookCrdt::from_update(config.notebook_id, &update)?),
            None => {
                let manifest = self.read_manifest()?;
                if !manifest.notes.is_empty() || !manifest.folders.is_empty() {
                    return Err(StorageError::InvalidManifest(
                        "state.bin is missing while the manifest still owns notes; restore state or re-link with --remove-state"
                            .to_owned(),
                    ));
                }
                let replica = NotebookCrdt::new(&config.notebook_id)?;
                let now = now_ms();
                replica.seed(
                    &NotebookSeed {
                        id: config.notebook_id,
                        name: config.notebook_name,
                        created_at: now,
                        updated_at: now,
                    },
                    &[],
                )?;
                Ok(replica)
            }
        }
    }

    pub fn scan(&self, notebook_id: &str) -> Result<ScanResult, StorageError> {
        self.scan_internal(notebook_id, None)
    }

    fn scan_internal(
        &self,
        notebook_id: &str,
        current_projection: Option<&NotebookSnapshot>,
    ) -> Result<ScanResult, StorageError> {
        let manifest = self.read_manifest()?;
        let current_folders: BTreeMap<&str, &Folder> = current_projection
            .map(|snapshot| snapshot.folders.as_slice())
            .unwrap_or_default()
            .iter()
            .map(|folder| (folder.id.as_str(), folder))
            .collect();
        let manifest_folder_ids: BTreeMap<String, String> = manifest
            .folders
            .iter()
            .map(|(id, path)| (path.clone(), id.clone()))
            .collect();
        let owners: HashMap<String, String> = manifest
            .notes
            .iter()
            .map(|(id, entry)| (entry.path.clone(), id.clone()))
            .collect();
        let mut result = ScanResult::default();
        let mut seen_ids = BTreeSet::new();
        let mut seen_owned_paths = BTreeSet::new();
        let mut folder_path_hints = BTreeMap::<String, String>::new();

        for entry in markdown_entries(&self.root) {
            let entry = match entry {
                Ok(value) => value,
                Err(path) => {
                    result.ignored_paths.push(path);
                    continue;
                }
            };
            let relative = relative_string(&self.root, entry.path())?;
            let owner = owners.get(&relative).cloned();
            if owner.is_some() {
                seen_owned_paths.insert(relative.clone());
            }
            let bytes = match read_regular_limited(entry.path(), MAX_MARKDOWN_BYTES) {
                Ok(Some(value)) => value,
                _ => {
                    result.ignored_paths.push(relative);
                    continue;
                }
            };
            let hash = sha256(&bytes);
            if let Some(owner) = &owner {
                if manifest
                    .notes
                    .get(owner)
                    .is_some_and(|value| value.hash == hash)
                {
                    seen_ids.insert(owner.clone());
                    continue;
                }
            }
            let source = match String::from_utf8(bytes) {
                Ok(source) => source,
                Err(_) => {
                    result.ignored_paths.push(relative);
                    continue;
                }
            };
            let metadata = fs::metadata(entry.path()).map_err(|error| io(entry.path(), error))?;
            let timestamp = modified_ms(&metadata).unwrap_or_else(now_ms);
            let mut note = match parse_markdown(
                &source,
                notebook_id,
                owner.as_deref(),
                &relative,
                timestamp,
            ) {
                Ok(value) => value,
                Err(_) => {
                    result.ignored_paths.push(relative);
                    continue;
                }
            };
            let parent = Path::new(&relative)
                .parent()
                .map(slash_path)
                .unwrap_or_default();
            if parent.is_empty() {
                note.folder_id = None;
            } else {
                let carried_folder_id = note.folder_id.clone();
                let carried_path_missing = carried_folder_id
                    .as_ref()
                    .and_then(|id| manifest.folders.get(id))
                    .is_some_and(|previous_path| {
                        let previous = self.root.join(
                            path_from_directory_manifest(previous_path)
                                .unwrap_or_else(|_| PathBuf::from(previous_path)),
                        );
                        matches!(
                            fs::symlink_metadata(previous),
                            Err(error) if error.kind() == std::io::ErrorKind::NotFound
                        )
                    });
                let folder_id = manifest_folder_ids
                    .get(&parent)
                    .cloned()
                    .or_else(|| carried_path_missing.then_some(carried_folder_id).flatten())
                    .unwrap_or_else(|| synthesized_folder_id(notebook_id, &parent));
                note.folder_id = Some(folder_id.clone());
                folder_path_hints
                    .entry(parent)
                    .and_modify(|existing| {
                        if folder_id.as_bytes() < existing.as_bytes() {
                            existing.clone_from(&folder_id);
                        }
                    })
                    .or_insert(folder_id);
            }
            if seen_ids.contains(&note.id) {
                result.ignored_paths.push(relative);
                continue;
            }
            if owner.is_none() {
                if let Some(previous) = manifest.notes.get(&note.id) {
                    if self.root.join(path_from_manifest(&previous.path)?).exists() {
                        result.ignored_paths.push(relative);
                        continue;
                    }
                }
                result
                    .preferred_paths
                    .insert(note.id.clone(), relative.clone());
            }
            if let Some(previous) = manifest.notes.get(&note.id) {
                if previous.path == relative && previous.hash == hash {
                    seen_ids.insert(note.id.clone());
                    continue;
                }
                note.updated_at = note.updated_at.max(now_ms());
            }
            seen_ids.insert(note.id.clone());
            result.witnesses.insert(
                note.id.clone(),
                ScanWitness {
                    path: relative,
                    hash: Some(hash),
                },
            );
            result.upserts.push(note);
        }

        let mut directories = BTreeMap::<String, u64>::new();
        for entry in directory_entries(&self.root) {
            let entry = match entry {
                Ok(value) => value,
                Err(path) => {
                    result.ignored_paths.push(path);
                    continue;
                }
            };
            let relative = match relative_directory_string(&self.root, entry.path()) {
                Ok(value) => value,
                Err(error) => {
                    result
                        .ignored_paths
                        .push(format!("{} ({error})", entry.path().display()));
                    continue;
                }
            };
            let timestamp = fs::metadata(entry.path())
                .ok()
                .and_then(|metadata| modified_ms(&metadata))
                .unwrap_or_else(now_ms);
            directories.insert(relative, timestamp);
        }

        let mut hinted_ids = BTreeMap::<String, String>::new();
        for (path, id) in &folder_path_hints {
            // A single former folder can be split into several directories in
            // one scan. Preserve its ID for only the UTF-8-smallest path and
            // synthesize distinct IDs for the others.
            hinted_ids.entry(id.clone()).or_insert_with(|| path.clone());
        }
        let mut folder_ids_by_path = BTreeMap::<String, String>::new();
        for path in directories.keys() {
            let id = folder_path_hints
                .get(path)
                .filter(|id| hinted_ids.get(id.as_str()) == Some(path))
                .cloned()
                .or_else(|| {
                    manifest_folder_ids.get(path).and_then(|id| {
                        hinted_ids
                            .get(id)
                            .is_none_or(|hinted_path| hinted_path == path)
                            .then_some(id.clone())
                    })
                })
                .unwrap_or_else(|| synthesized_folder_id(notebook_id, path));
            folder_ids_by_path.insert(path.clone(), id);
        }
        // Several notes can be moved into the same previously unknown
        // directory in one filesystem operation. Their embedded metadata can
        // carry different former folder IDs, so converge every note on the
        // deterministic ID selected for its actual parent directory.
        for note in &mut result.upserts {
            let Some(witness) = result.witnesses.get(&note.id) else {
                continue;
            };
            let parent_path = Path::new(&witness.path)
                .parent()
                .map(slash_path)
                .unwrap_or_default();
            note.folder_id = if parent_path.is_empty() {
                None
            } else {
                folder_ids_by_path.get(&parent_path).cloned()
            };
        }
        for (path, id) in &folder_ids_by_path {
            let parent_path = Path::new(path).parent().map(slash_path).unwrap_or_default();
            let name = Path::new(path)
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("Folder")
                .to_owned();
            let timestamp = directories.get(path).copied().unwrap_or_else(now_ms);
            let current_folder = current_folders.get(id.as_str()).copied();
            let (created_at, updated_at) =
                current_folder.map_or((timestamp, timestamp), |current| {
                    (
                        current.created_at,
                        timestamp
                            .max(now_ms())
                            .max(current.updated_at.saturating_add(1).min(MAX_SAFE_TIMESTAMP)),
                    )
                });
            let candidate = Folder {
                id: id.clone(),
                name,
                parent_folder_id: folder_ids_by_path.get(&parent_path).cloned(),
                created_at,
                updated_at,
                deleted: false,
                deleted_at: None,
            };
            let already_projected = current_folder.is_some_and(|current| {
                !current.deleted
                    && current.name.as_str() == candidate.name.as_str()
                    && current.parent_folder_id.as_deref() == candidate.parent_folder_id.as_deref()
            });
            if !already_projected {
                result.folder_witnesses.insert(
                    id.clone(),
                    FolderScanWitness {
                        path: path.clone(),
                        exists: true,
                    },
                );
                result.folder_upserts.push(candidate);
            }
        }
        let seen_folder_ids: BTreeSet<String> = folder_ids_by_path.values().cloned().collect();
        for (id, path) in &manifest.folders {
            // An empty path is the compatibility mapping for a legacy note
            // whose folder entity is unavailable; it represents vault root,
            // which directory_entries intentionally does not enumerate.
            if path.is_empty() {
                continue;
            }
            if !seen_folder_ids.contains(id) && !directories.contains_key(path) {
                result.deleted_folder_ids.push(id.clone());
                result.folder_witnesses.insert(
                    id.clone(),
                    FolderScanWitness {
                        path: path.clone(),
                        exists: false,
                    },
                );
            }
        }

        for (id, entry) in &manifest.notes {
            if seen_ids.contains(id) || seen_owned_paths.contains(&entry.path) {
                continue;
            }
            let destination = self.root.join(path_from_manifest(&entry.path)?);
            if let Err(error) = validate_existing_parent(&self.root, &destination) {
                result
                    .ignored_paths
                    .push(format!("{} ({error})", entry.path));
                continue;
            }
            result.deleted_note_ids.push(id.clone());
            result.witnesses.insert(
                id.clone(),
                ScanWitness {
                    path: entry.path.clone(),
                    hash: None,
                },
            );
        }
        result.upserts.sort_by(|left, right| left.id.cmp(&right.id));
        result
            .folder_upserts
            .sort_by(|left, right| left.id.cmp(&right.id));
        result.deleted_folder_ids.sort();
        result.ignored_paths.sort();
        Ok(result)
    }

    pub fn reconcile(&self, now: u64) -> Result<ReconcileResult, StorageError> {
        let replica = self.load_replica()?;
        let before = replica.encode_state_vector_v1();
        let current_projection = replica.snapshot()?;
        let mut scan = self.scan_internal(replica.notebook_id(), Some(&current_projection))?;
        self.revalidate_folder_witnesses(&mut scan);
        let mut current = BTreeSet::new();
        for (id, witness) in &scan.witnesses {
            let destination = self.root.join(path_from_manifest(&witness.path)?);
            if hash_regular_inside(&self.root, &destination).is_ok_and(|hash| hash == witness.hash)
            {
                current.insert(id.clone());
            } else {
                scan.ignored_paths
                    .push(format!("{} (changed during reconciliation)", witness.path));
            }
        }
        scan.upserts.retain(|note| current.contains(&note.id));
        scan.deleted_note_ids.retain(|id| current.contains(id));
        scan.witnesses.retain(|id, _| current.contains(id));
        scan.ignored_paths.sort();
        for folder in &scan.folder_upserts {
            replica.upsert_folder(folder)?;
        }
        for folder_id in &scan.deleted_folder_ids {
            replica.delete_folder(folder_id, now)?;
        }
        for note in &scan.upserts {
            replica.upsert_note(note)?;
        }
        for note_id in &scan.deleted_note_ids {
            replica.delete_note(note_id, now)?;
        }
        let snapshot = replica.snapshot()?;
        // State is the source of truth. Persist it before updating any
        // projection hashes so a crash can never make a file look accounted
        // for while its CRDT operation is missing.
        self.write_state(&replica.encode_state_as_update_v1())?;
        let materialized =
            self.materialize_internal(&snapshot, &scan.preferred_paths, &scan.witnesses, now)?;
        Ok(ReconcileResult {
            update: replica.encode_diff_v1(&before)?,
            snapshot,
            scan,
            materialized,
        })
    }

    fn revalidate_folder_witnesses(&self, scan: &mut ScanResult) {
        let mut current = BTreeSet::new();
        for (id, witness) in &scan.folder_witnesses {
            match directory_presence_inside(&self.root, &witness.path) {
                Ok(exists) if exists == witness.exists => {
                    current.insert(id.clone());
                }
                Ok(_) => scan.ignored_paths.push(format!(
                    "{} (changed during folder reconciliation)",
                    witness.path
                )),
                Err(error) => scan
                    .ignored_paths
                    .push(format!("{} ({error})", witness.path)),
            }
        }
        scan.folder_upserts
            .retain(|folder| current.contains(&folder.id));
        scan.deleted_folder_ids.retain(|id| current.contains(id));
        scan.folder_witnesses.retain(|id, _| current.contains(id));
        scan.ignored_paths.sort();
        scan.ignored_paths.dedup();
    }

    /// Persist a remote CRDT state and safely project it. Unsynced local files
    /// are copied to explicit conflict notes before the remote value wins.
    pub fn persist_and_materialize(
        &self,
        replica: &NotebookCrdt,
        now: u64,
    ) -> Result<MaterializeResult, StorageError> {
        let snapshot = replica.snapshot()?;
        self.write_state(&replica.encode_state_as_update_v1())?;
        let result =
            self.materialize_internal(&snapshot, &BTreeMap::new(), &BTreeMap::new(), now)?;
        Ok(result)
    }

    pub fn materialize(
        &self,
        snapshot: &NotebookSnapshot,
        now: u64,
    ) -> Result<MaterializeResult, StorageError> {
        self.materialize_internal(snapshot, &BTreeMap::new(), &BTreeMap::new(), now)
    }

    fn materialize_internal(
        &self,
        snapshot: &NotebookSnapshot,
        preferred_paths: &BTreeMap<String, String>,
        witnesses: &BTreeMap<String, ScanWitness>,
        now: u64,
    ) -> Result<MaterializeResult, StorageError> {
        let mut manifest = self.read_manifest()?;
        let mut result = MaterializeResult::default();
        let previous_folders = manifest.folders.clone();
        let known_folder_ids: BTreeSet<String> = snapshot
            .folders
            .iter()
            .map(|folder| folder.id.clone())
            .collect();
        let desired_folders = projected_folder_paths(snapshot);
        let mut protected_folder_ids = BTreeSet::new();
        for folder in &snapshot.folders {
            if folder.deleted {
                manifest.folders.remove(&folder.id);
            } else if let Some(path) = desired_folders.get(&folder.id) {
                match ensure_safe_directory(&self.root, path) {
                    Ok(()) => {}
                    Err(StorageError::UnsafePath(_)) => {
                        protected_folder_ids.insert(folder.id.clone());
                        result.protected_paths.push(path.clone());
                    }
                    Err(error) => return Err(error),
                }
                manifest.folders.insert(folder.id.clone(), path.clone());
            }
        }
        let mut owners: HashMap<String, String> = manifest
            .notes
            .iter()
            .map(|(id, entry)| (entry.path.clone(), id.clone()))
            .collect();

        for note in snapshot.notes.iter().filter(|note| note.deleted) {
            let Some(previous) = manifest.notes.get(&note.id).cloned() else {
                continue;
            };
            let destination = self.root.join(path_from_manifest(&previous.path)?);
            if validate_existing_parent(&self.root, &destination).is_err() {
                result.protected_paths.push(previous.path.clone());
                continue;
            }
            let disk_hash = hash_regular_inside(&self.root, &destination)?;
            let witnessed = witnesses
                .get(&note.id)
                .is_some_and(|witness| witness.path == previous.path && witness.hash == disk_hash);
            if disk_hash.as_deref() != Some(&previous.hash) && !witnessed {
                // A dirty file must not remain mapped to a tombstoned note: a
                // later scan would explicitly restore it. Preserve the local
                // value as a new, metadata-free conflict note, then retire the
                // managed path and manifest ownership.
                if let Some(conflict) =
                    preserve_conflict(&self.root, &destination, &previous.path, now, &owners)?
                {
                    result.conflict_paths.push(conflict);
                }
            }
            if remove_regular_file_inside(&self.root, &destination)? {
                result.removed_paths.push(previous.path.clone());
            }
            owners.remove(&previous.path);
            manifest.notes.remove(&note.id);
        }

        for note in snapshot.notes.iter().filter(|note| !note.deleted) {
            let source = serialize_note(snapshot, note)?;
            let hash = sha256(source.as_bytes());
            let previous = manifest.notes.get(&note.id).cloned();
            if note
                .folder_id
                .as_ref()
                .is_some_and(|folder_id| protected_folder_ids.contains(folder_id))
            {
                if let Some(previous) = previous {
                    result.protected_paths.push(previous.path);
                }
                continue;
            }
            let witnessed_preferred = preferred_paths.get(&note.id).filter(|preferred| {
                witnesses
                    .get(&note.id)
                    .is_some_and(|witness| &witness.path == *preferred)
            });
            let desired_directory = note
                .folder_id
                .as_ref()
                .and_then(|id| manifest.folders.get(id))
                .cloned()
                .unwrap_or_default();
            let previous_matches_folder = previous.as_ref().is_some_and(|entry| {
                let parent = Path::new(&entry.path)
                    .parent()
                    .unwrap_or_else(|| Path::new(""));
                slash_path(parent) == desired_directory
            });
            let path = if let Some(preferred) = witnessed_preferred {
                validate_relative_markdown(preferred)?;
                preferred.clone()
            } else if previous_matches_folder {
                let previous = previous.as_ref().expect("checked above");
                previous.path.clone()
            } else {
                allocate_path(&self.root, note, &manifest, &owners)?
            };
            let destination = self.root.join(path_from_manifest(&path)?);
            let moving = previous
                .as_ref()
                .is_some_and(|previous| previous.path != path);
            if moving {
                let previous = previous.as_ref().expect("checked above");
                let old = self.root.join(path_from_manifest(&previous.path)?);
                if validate_existing_parent(&self.root, &old).is_err() {
                    result.protected_paths.push(previous.path.clone());
                    continue;
                }
                let disk_hash = hash_regular_inside(&self.root, &old)?;
                let witnessed = witnesses.get(&note.id).is_some_and(|witness| {
                    witness.path == previous.path && witness.hash == disk_hash
                });
                if disk_hash.as_deref() != Some(&previous.hash) && !witnessed {
                    if let Some(conflict) =
                        preserve_conflict(&self.root, &old, &previous.path, now, &owners)?
                    {
                        result.conflict_paths.push(conflict);
                    }
                }
            } else if previous.is_some()
                && validate_existing_parent(&self.root, &destination).is_err()
            {
                result.protected_paths.push(path);
                continue;
            }
            ensure_safe_parent(&self.root, &destination)?;
            if let Some(previous) = previous.as_ref().filter(|_| !moving) {
                let disk_hash = hash_regular_inside(&self.root, &destination)?;
                let witnessed = witnesses
                    .get(&note.id)
                    .is_some_and(|witness| witness.path == path && witness.hash == disk_hash);
                if disk_hash.as_deref() != Some(&previous.hash)
                    && !witnessed
                    && disk_hash.as_deref() != Some(&hash)
                {
                    if let Some(conflict) =
                        preserve_conflict(&self.root, &destination, &path, now, &owners)?
                    {
                        result.conflict_paths.push(conflict);
                    }
                }
            }
            if hash_regular_inside(&self.root, &destination)?.as_deref() != Some(&hash) {
                atomic_write(&destination, source.as_bytes(), 0o644)?;
                self.remember_self_write(&destination, &hash);
                result.written_paths.push(path.clone());
            }
            if let Some(previous) = &previous {
                if previous.path != path {
                    let old = self.root.join(path_from_manifest(&previous.path)?);
                    if remove_regular_file_inside(&self.root, &old)? {
                        result.removed_paths.push(previous.path.clone());
                    }
                    owners.remove(&previous.path);
                }
            }
            if let Some(folder) = note
                .folder_id
                .as_ref()
                .filter(|folder| !known_folder_ids.contains(*folder))
            {
                // Legacy documents can contain folderId values without the
                // additive folders root. Retain that compatibility mapping,
                // but never recreate a known folder that was tombstoned.
                let parent = Path::new(&path).parent().unwrap_or_else(|| Path::new(""));
                manifest.folders.insert(folder.clone(), slash_path(parent));
            }
            owners.insert(path.clone(), note.id.clone());
            manifest
                .notes
                .insert(note.id.clone(), ManifestEntry { path, hash });
        }
        let current_folder_paths: BTreeSet<String> = manifest.folders.values().cloned().collect();
        let mut stale_folder_paths: Vec<String> = previous_folders
            .into_iter()
            .filter_map(|(id, previous)| {
                (manifest.folders.get(&id) != Some(&previous)).then_some(previous)
            })
            .filter(|path| !path.is_empty() && !current_folder_paths.contains(path))
            .collect();
        stale_folder_paths.sort_by_key(|path| std::cmp::Reverse(path.matches('/').count()));
        stale_folder_paths.dedup();
        for path in stale_folder_paths {
            let _removed = remove_empty_directory_inside(&self.root, &path)?;
        }
        result.written_paths.sort();
        result.removed_paths.sort();
        result.protected_paths.sort();
        result.conflict_paths.sort();
        self.write_manifest(&manifest)?;
        result.manifest = manifest;
        Ok(result)
    }

    pub fn status(&self) -> Result<MirrorStatus, StorageError> {
        let config = self.read_link().ok();
        let manifest = self.read_manifest()?;
        let (pending_local_changes, ignored_paths) = if let Some(config) = &config {
            let current_projection = match self.read_state()? {
                Some(update) => {
                    Some(NotebookCrdt::from_update(&config.notebook_id, &update)?.snapshot()?)
                }
                None => None,
            };
            let scan = self.scan_internal(&config.notebook_id, current_projection.as_ref())?;
            (
                scan.folder_upserts.len()
                    + scan.deleted_folder_ids.len()
                    + scan.upserts.len()
                    + scan.deleted_note_ids.len(),
                scan.ignored_paths,
            )
        } else {
            (0, Vec::new())
        };
        Ok(MirrorStatus {
            root: self.root.clone(),
            linked: config.is_some(),
            notebook_id: config.as_ref().map(|value| value.notebook_id.clone()),
            conversation_id: config.as_ref().map(|value| value.conversation_id.clone()),
            expected_inbox_id: config.and_then(|value| value.expected_inbox_id),
            tracked_notes: manifest.notes.len(),
            markdown_files: markdown_entries(&self.root).filter(Result::is_ok).count(),
            pending_local_changes,
            ignored_paths,
        })
    }

    pub fn watch(&self) -> Result<MirrorWatcher, StorageError> {
        let (sender, receiver) = mpsc::channel();
        let root = self.root.clone();
        let hashes = Arc::clone(&self.self_hashes);
        let mut watcher =
            notify::recommended_watcher(move |event: Result<Event, notify::Error>| {
                let classified = match event {
                    Err(error) => MirrorEvent::Error(error.to_string()),
                    Ok(event) => classify_event(&root, &hashes, event),
                };
                let _ignored = sender.send(classified);
            })?;
        watcher.watch(&self.root, RecursiveMode::Recursive)?;
        Ok(MirrorWatcher { watcher, receiver })
    }

    fn remember_self_write(&self, path: &Path, hash: &str) {
        if let Ok(mut values) = self.self_hashes.lock() {
            values.insert(path.to_path_buf(), hash.to_owned());
        }
    }
}

pub struct MirrorWatcher {
    watcher: RecommendedWatcher,
    receiver: mpsc::Receiver<MirrorEvent>,
}

impl MirrorWatcher {
    pub fn recv(&self) -> Result<MirrorEvent, mpsc::RecvError> {
        self.receiver.recv()
    }

    pub fn recv_timeout(&self, timeout: Duration) -> Result<MirrorEvent, mpsc::RecvTimeoutError> {
        self.receiver.recv_timeout(timeout)
    }

    pub fn stop(mut self, root: &Path) -> Result<(), notify::Error> {
        self.watcher.unwatch(root)
    }
}

fn classify_event(
    root: &Path,
    hashes: &Arc<Mutex<HashMap<PathBuf, String>>>,
    event: Event,
) -> MirrorEvent {
    let paths: Vec<PathBuf> = event
        .paths
        .into_iter()
        .filter(|path| is_relevant_path(root, path))
        .collect();
    if paths.is_empty() {
        return MirrorEvent::SelfWrite(paths);
    }
    let is_self = if let Ok(mut expected) = hashes.lock() {
        paths.iter().all(|path| {
            let Some(hash) = expected.get(path).cloned() else {
                return false;
            };
            if hash_regular(path).ok().flatten().as_deref() == Some(&hash) {
                expected.remove(path);
                true
            } else {
                false
            }
        })
    } else {
        false
    };
    if is_self {
        MirrorEvent::SelfWrite(paths)
    } else {
        MirrorEvent::External(paths)
    }
}

fn is_relevant_path(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    if relative
        .components()
        .any(|component| component.as_os_str().to_string_lossy().starts_with('.'))
    {
        return false;
    }
    path.extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
        || fs::metadata(path)
            .map(|metadata| metadata.is_dir())
            // A removed or renamed directory no longer has metadata. Treat the
            // event as relevant and let the hash scan decide what changed.
            .unwrap_or(true)
}

fn validate_manifest(mut manifest: Manifest) -> Result<Manifest, StorageError> {
    if manifest.schema != 1 && manifest.schema != MIRROR_SCHEMA {
        return Err(StorageError::InvalidManifest(format!(
            "unsupported schema {}",
            manifest.schema
        )));
    }
    let mut paths = BTreeSet::new();
    for (id, entry) in &manifest.notes {
        if id.is_empty()
            || entry.hash.len() != 64
            || !entry.hash.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(StorageError::InvalidManifest(
                "invalid note entry".to_owned(),
            ));
        }
        validate_relative_markdown(&entry.path)?;
        if !paths.insert(entry.path.clone()) {
            return Err(StorageError::InvalidManifest(
                "multiple notes claim the same path".to_owned(),
            ));
        }
    }
    for path in manifest.folders.values() {
        validate_relative_directory(path)?;
    }
    manifest.schema = MIRROR_SCHEMA;
    Ok(manifest)
}

fn read_regular_limited(path: &Path, maximum: u64) -> Result<Option<Vec<u8>>, StorageError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io(path, error)),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(StorageError::UnsafePath(path.display().to_string()));
    }
    if metadata.len() > maximum {
        return Err(StorageError::UnsafePath(format!(
            "{} exceeds size limit",
            path.display()
        )));
    }
    let file = File::open(path).map_err(|error| io(path, error))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(maximum + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| io(path, error))?;
    if bytes.len() as u64 > maximum {
        return Err(StorageError::UnsafePath(format!(
            "{} exceeds size limit",
            path.display()
        )));
    }
    Ok(Some(bytes))
}

fn atomic_write(path: &Path, bytes: &[u8], mode: u32) -> Result<(), StorageError> {
    let parent = path
        .parent()
        .ok_or_else(|| StorageError::UnsafePath(path.display().to_string()))?;
    fs::create_dir_all(parent).map_err(|error| io(parent, error))?;
    let atomic = AtomicFile::new(path, AllowOverwrite);
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;
    atomic
        .write_with_options(
            |file| {
                file.write_all(bytes)?;
                file.sync_all()
            },
            options,
        )
        .map_err(|error: atomicwrites::Error<std::io::Error>| io(path, error.into()))
}

/// Validate every existing parent component before writing. Atomic rename
/// protects the destination itself; an attacker with concurrent access can
/// still race parent replacement on platforms without directory-handle APIs.
fn ensure_safe_parent(root: &Path, destination: &Path) -> Result<(), StorageError> {
    let relative = destination
        .strip_prefix(root)
        .map_err(|_| StorageError::UnsafePath(destination.display().to_string()))?;
    let parent = relative
        .parent()
        .ok_or_else(|| StorageError::UnsafePath(destination.display().to_string()))?;
    let mut current = root.to_path_buf();
    for component in parent.components() {
        let Component::Normal(component) = component else {
            return Err(StorageError::UnsafePath(destination.display().to_string()));
        };
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(StorageError::UnsafePath(current.display().to_string()));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current).map_err(|error| io(&current, error))?;
            }
            Err(error) => return Err(io(&current, error)),
        }
    }
    let canonical = fs::canonicalize(destination.parent().unwrap_or(root))
        .map_err(|error| io(destination, error))?;
    if !canonical.starts_with(root) {
        return Err(StorageError::UnsafePath(destination.display().to_string()));
    }
    Ok(())
}

/// Validate every existing parent without creating directories. This must run
/// immediately before reads and destructive operations so a manifest path can
/// never traverse a symlinked folder outside the canonical vault.
fn validate_existing_parent(root: &Path, destination: &Path) -> Result<bool, StorageError> {
    let relative = destination
        .strip_prefix(root)
        .map_err(|_| StorageError::UnsafePath(destination.display().to_string()))?;
    let parent = relative
        .parent()
        .ok_or_else(|| StorageError::UnsafePath(destination.display().to_string()))?;
    let mut current = root.to_path_buf();
    for component in parent.components() {
        let Component::Normal(component) = component else {
            return Err(StorageError::UnsafePath(destination.display().to_string()));
        };
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(StorageError::UnsafePath(current.display().to_string()));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(io(&current, error)),
        }
    }
    let canonical = fs::canonicalize(destination.parent().unwrap_or(root))
        .map_err(|error| io(destination, error))?;
    if !canonical.starts_with(root) {
        return Err(StorageError::UnsafePath(destination.display().to_string()));
    }
    Ok(true)
}

fn read_regular_limited_inside(
    root: &Path,
    path: &Path,
    maximum: u64,
) -> Result<Option<Vec<u8>>, StorageError> {
    if !validate_existing_parent(root, path)? {
        return Ok(None);
    }
    read_regular_limited(path, maximum)
}

fn hash_regular_inside(root: &Path, path: &Path) -> Result<Option<String>, StorageError> {
    if !validate_existing_parent(root, path)? {
        return Ok(None);
    }
    hash_regular(path)
}

fn remove_regular_file_inside(root: &Path, path: &Path) -> Result<bool, StorageError> {
    if !validate_existing_parent(root, path)? {
        return Ok(false);
    }
    remove_regular_file(path)
}

fn remove_regular_file(path: &Path) -> Result<bool, StorageError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(io(path, error)),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Ok(false);
    }
    fs::remove_file(path).map_err(|error| io(path, error))?;
    Ok(true)
}

fn hash_regular(path: &Path) -> Result<Option<String>, StorageError> {
    Ok(read_regular_limited(path, MAX_MARKDOWN_BYTES)?.map(|bytes| sha256(&bytes)))
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn with_newline(mut bytes: Vec<u8>) -> Vec<u8> {
    bytes.push(b'\n');
    bytes
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(MAX_SAFE_TIMESTAMP as u128) as u64
}

fn modified_ms(metadata: &fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|value| value.as_millis().min(MAX_SAFE_TIMESTAMP as u128) as u64)
}

fn is_hidden(entry: &DirEntry) -> bool {
    entry.depth() > 0 && entry.file_name().to_string_lossy().starts_with('.')
}

fn markdown_entries(root: &Path) -> impl Iterator<Item = Result<DirEntry, String>> {
    WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| !is_hidden(entry))
        .filter_map(|entry| match entry {
            Ok(entry)
                if entry.depth() > 0
                    && entry.file_type().is_file()
                    && entry
                        .path()
                        .extension()
                        .is_some_and(|extension| extension.eq_ignore_ascii_case("md")) =>
            {
                Some(Ok(entry))
            }
            Ok(_) => None,
            Err(error) => Some(Err(error.to_string())),
        })
}

fn directory_entries(root: &Path) -> impl Iterator<Item = Result<DirEntry, String>> {
    WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| !is_hidden(entry))
        .filter_map(|entry| match entry {
            Ok(entry) if entry.depth() > 0 && entry.file_type().is_dir() => Some(Ok(entry)),
            Ok(_) => None,
            Err(error) => Some(Err(error.to_string())),
        })
}

fn relative_string(root: &Path, path: &Path) -> Result<String, StorageError> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| StorageError::UnsafePath(path.display().to_string()))?;
    let string = slash_path(relative);
    validate_relative_markdown(&string)?;
    Ok(string)
}

fn relative_directory_string(root: &Path, path: &Path) -> Result<String, StorageError> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| StorageError::UnsafePath(path.display().to_string()))?;
    let string = slash_path(relative);
    validate_relative_directory(&string)?;
    Ok(string)
}

fn slash_path(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn validate_components(path: &str, allow_empty: bool) -> Result<(), StorageError> {
    if path.contains('\0') || path.contains('\\') || path.starts_with('/') {
        return Err(StorageError::UnsafePath(path.to_owned()));
    }
    if path.is_empty() && allow_empty {
        return Ok(());
    }
    let parsed = Path::new(path);
    if parsed.as_os_str().is_empty()
        || parsed.components().any(|component| {
            !matches!(component, Component::Normal(_))
                || component.as_os_str().to_string_lossy().starts_with('.')
        })
    {
        return Err(StorageError::UnsafePath(path.to_owned()));
    }
    Ok(())
}

fn validate_relative_markdown(path: &str) -> Result<(), StorageError> {
    validate_components(path, false)?;
    if !Path::new(path)
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
    {
        return Err(StorageError::UnsafePath(path.to_owned()));
    }
    Ok(())
}

fn validate_relative_directory(path: &str) -> Result<(), StorageError> {
    validate_components(path, true)
}

fn path_from_manifest(path: &str) -> Result<PathBuf, StorageError> {
    validate_relative_markdown(path)?;
    Ok(path.split('/').collect())
}

fn path_from_directory_manifest(path: &str) -> Result<PathBuf, StorageError> {
    validate_relative_directory(path)?;
    Ok(path.split('/').collect())
}

fn encode_uri_component(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            encoded.push(char::from(byte));
        } else {
            encoded.push('%');
            encoded.push(char::from(HEX[(byte >> 4) as usize]));
            encoded.push(char::from(HEX[(byte & 0x0f) as usize]));
        }
    }
    encoded
}

fn synthesized_folder_id(notebook_id: &str, path: &str) -> String {
    format!(
        "obsidian:path:{}:{}",
        encode_uri_component(notebook_id),
        encode_uri_component(path)
    )
}

fn parse_markdown(
    source: &str,
    expected_notebook_id: &str,
    owner_id: Option<&str>,
    relative_path: &str,
    timestamp: u64,
) -> Result<Note, StorageError> {
    let mut metadata_value: Option<Metadata> = None;
    let mut metadata_range = None;
    let mut offset = 0;
    let mut fence: Option<char> = None;
    for line in source.split_inclusive('\n') {
        let clean = line.trim_end_matches(['\r', '\n']);
        let trimmed = clean.trim_start();
        if trimmed.starts_with("```") {
            fence = if fence == Some('`') {
                None
            } else if fence.is_none() {
                Some('`')
            } else {
                fence
            };
        } else if trimmed.starts_with("~~~") {
            fence = if fence == Some('~') {
                None
            } else if fence.is_none() {
                Some('~')
            } else {
                fence
            };
        }
        if fence.is_none() && clean.starts_with("# ") {
            break;
        }
        if fence.is_none() && clean.starts_with(METADATA_PREFIX) {
            if !clean.ends_with(METADATA_SUFFIX) {
                return Err(StorageError::InvalidMetadata(
                    "malformed metadata comment".to_owned(),
                ));
            }
            let json = &clean[METADATA_PREFIX.len()..clean.len() - METADATA_SUFFIX.len()];
            let metadata: Metadata = serde_json::from_str(json)
                .map_err(|error| StorageError::InvalidMetadata(error.to_string()))?;
            if metadata.schema != 1 && metadata.schema != MIRROR_SCHEMA {
                return Err(StorageError::InvalidMetadata(
                    "unsupported metadata schema".to_owned(),
                ));
            }
            if metadata.notebook_id != expected_notebook_id {
                return Err(StorageError::InvalidMetadata(
                    "note belongs to a different notebook".to_owned(),
                ));
            }
            if let Some(owner_id) = owner_id {
                if metadata.note_id != owner_id {
                    return Err(StorageError::InvalidMetadata(
                        "metadata note ID does not match manifest ownership".to_owned(),
                    ));
                }
            }
            metadata_value = Some(metadata);
            metadata_range = Some(offset..offset + line.len());
            break;
        }
        offset += line.len();
        if offset > 128 * 1024 {
            break;
        }
    }

    let without_metadata = if let Some(range) = metadata_range {
        format!("{}{}", &source[..range.start], &source[range.end..])
    } else {
        source.to_owned()
    };
    let (title, content) = extract_title_and_content(&without_metadata, relative_path);
    let parent = Path::new(relative_path)
        .parent()
        .unwrap_or_else(|| Path::new(""));
    let inferred_folder = if parent.as_os_str().is_empty() {
        None
    } else {
        Some(synthesized_folder_id(
            expected_notebook_id,
            &slash_path(parent),
        ))
    };
    let metadata = metadata_value;
    Ok(Note {
        id: metadata
            .as_ref()
            .map(|value| value.note_id.clone())
            .or_else(|| owner_id.map(str::to_owned))
            .unwrap_or_else(|| Uuid::new_v4().to_string()),
        title,
        content,
        folder_id: metadata
            .as_ref()
            .and_then(|value| value.folder_id.clone())
            .or(inferred_folder),
        created_at: metadata
            .as_ref()
            .map_or(timestamp, |value| value.created_at),
        updated_at: metadata
            .as_ref()
            .map_or(timestamp, |value| value.updated_at.max(timestamp)),
        deleted: false,
        deleted_at: None,
    })
}

fn extract_title_and_content(source: &str, relative_path: &str) -> (String, String) {
    let mut offset = 0;
    let mut fence: Option<char> = None;
    let mut frontmatter = source.starts_with("---\n") || source.starts_with("---\r\n");
    for (index, line) in source.split_inclusive('\n').enumerate() {
        let clean = line.trim_end_matches(['\r', '\n']);
        if frontmatter {
            offset += line.len();
            if index > 0 && matches!(clean, "---" | "...") {
                frontmatter = false;
            }
            continue;
        }
        let trimmed = clean.trim_start();
        if trimmed.starts_with("```") {
            fence = if fence == Some('`') {
                None
            } else if fence.is_none() {
                Some('`')
            } else {
                fence
            };
            offset += line.len();
            continue;
        }
        if trimmed.starts_with("~~~") {
            fence = if fence == Some('~') {
                None
            } else if fence.is_none() {
                Some('~')
            } else {
                fence
            };
            offset += line.len();
            continue;
        }
        if fence.is_none() {
            if let Some(title) = clean.strip_prefix("# ") {
                let end = offset + line.len();
                let mut content = format!("{}{}", &source[..offset], &source[end..]);
                if source[..offset].is_empty() {
                    content = content.trim_start_matches(['\r', '\n']).to_owned();
                }
                return (normalize_title(title), content);
            }
        }
        offset += line.len();
    }
    let title = Path::new(relative_path)
        .file_stem()
        .and_then(|value| value.to_str())
        .map(normalize_title)
        .unwrap_or_else(|| "Untitled".to_owned());
    (title, source.to_owned())
}

fn normalize_title(value: &str) -> String {
    let title = value
        .chars()
        .map(|character| {
            if character == '\r' || character == '\n' || character == '\0' {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();
    let title = title.trim();
    if title.is_empty() {
        "Untitled".to_owned()
    } else {
        title.to_owned()
    }
}

fn split_frontmatter(content: &str) -> Option<(&str, &str)> {
    if !content.starts_with("---\n") && !content.starts_with("---\r\n") {
        return None;
    }
    let mut offset = 0;
    for (index, line) in content.split_inclusive('\n').enumerate() {
        offset += line.len();
        if index > 0 && matches!(line.trim_end_matches(['\r', '\n']), "---" | "...") {
            return Some((&content[..offset], &content[offset..]));
        }
    }
    None
}

fn serialize_note(snapshot: &NotebookSnapshot, note: &Note) -> Result<String, StorageError> {
    let metadata = Metadata {
        schema: MIRROR_SCHEMA,
        notebook_id: snapshot.notebook.id.clone(),
        note_id: note.id.clone(),
        folder_id: note.folder_id.clone(),
        created_at: note.created_at,
        updated_at: note.updated_at,
    };
    let json = serde_json::to_string(&metadata)
        .map_err(|error| StorageError::InvalidMetadata(error.to_string()))?
        .replace("-->", "--\\u003e");
    let marker = format!("{METADATA_PREFIX}{json}{METADATA_SUFFIX}\n");
    let title = normalize_title(&note.title);
    if let Some((frontmatter, rest)) = split_frontmatter(&note.content) {
        Ok(format!(
            "{frontmatter}{marker}# {title}\n\n{}",
            rest.trim_start_matches(['\r', '\n'])
        ))
    } else {
        Ok(format!("{marker}# {title}\n\n{}", note.content))
    }
}

fn sanitize_file_name(title: &str) -> String {
    let value = normalize_title(title)
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            character if character.is_control() => '-',
            character => character,
        })
        .collect::<String>();
    let value = value.trim_matches([' ', '.', '-']);
    let value: String = value
        .chars()
        .take(96)
        .collect::<String>()
        .trim_matches([' ', '.', '-'])
        .to_owned();
    let value = if value.is_empty() {
        "Untitled".to_owned()
    } else {
        value
    };
    let upper = value.to_ascii_uppercase();
    let stem = upper.split('.').next().unwrap_or(&upper);
    let reserved = matches!(stem, "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'));
    if reserved {
        format!("_{value}")
    } else {
        value
    }
}

fn projected_folder_paths(snapshot: &NotebookSnapshot) -> BTreeMap<String, String> {
    let folders: BTreeMap<String, &Folder> = snapshot
        .folders
        .iter()
        .filter(|folder| !folder.deleted)
        .map(|folder| (folder.id.clone(), folder))
        .collect();
    let active: BTreeSet<String> = folders.keys().cloned().collect();
    let mut parents: BTreeMap<String, Option<String>> = folders
        .iter()
        .map(|(id, folder)| {
            let parent = folder
                .parent_folder_id
                .as_ref()
                .filter(|parent| *parent != id && active.contains(*parent))
                .cloned();
            (id.clone(), parent)
        })
        .collect();

    // Match the browser/core projection rules: invalid parents become roots,
    // and every cycle is broken at its UTF-8-smallest ID. Rust string ordering
    // is lexicographic over UTF-8 bytes, which is the browser's explicit order.
    let mut visited = BTreeSet::new();
    for id in folders.keys() {
        if visited.contains(id) {
            continue;
        }
        let mut path = Vec::<String>::new();
        let mut indexes = HashMap::<String, usize>::new();
        let mut current = Some(id.clone());
        while let Some(current_id) = current {
            if !active.contains(&current_id) || visited.contains(&current_id) {
                break;
            }
            if let Some(cycle_start) = indexes.get(&current_id).copied() {
                if let Some(root) = path[cycle_start..].iter().min().cloned() {
                    parents.insert(root, None);
                }
                break;
            }
            indexes.insert(current_id.clone(), path.len());
            path.push(current_id.clone());
            current = parents.get(&current_id).cloned().flatten();
        }
        visited.extend(path);
    }

    // Allocate collision-safe components among siblings before building full
    // paths. This means a child's path always uses its parent's final suffixed
    // component, even when two parents sanitize to the same name.
    let mut claimed_by_parent = BTreeMap::<Option<String>, BTreeSet<String>>::new();
    let mut components = BTreeMap::<String, String>::new();
    for (id, folder) in &folders {
        let parent = parents.get(id).cloned().flatten();
        let claimed = claimed_by_parent.entry(parent).or_default();
        let base = sanitize_file_name(&folder.name);
        let fragment = &sha256(id.as_bytes())[..8];
        let mut attempt = 0usize;
        let component = loop {
            let candidate = match attempt {
                0 => base.clone(),
                1 => format!("{base}--{fragment}"),
                _ => format!("{base}--{fragment}-{attempt}"),
            };
            // Allocate portable paths even when projection runs on a
            // case-sensitive filesystem and is later opened on Windows/macOS.
            if claimed.insert(candidate.to_lowercase()) {
                break candidate;
            }
            attempt += 1;
        };
        components.insert(id.clone(), component);
    }

    // Resolve iteratively to avoid stack growth for deeply nested vaults.
    let mut resolved = BTreeMap::<String, String>::new();
    for id in folders.keys() {
        if resolved.contains_key(id) {
            continue;
        }
        let mut chain = Vec::new();
        let mut current = Some(id.clone());
        while let Some(current_id) = current {
            if resolved.contains_key(&current_id) {
                break;
            }
            chain.push(current_id.clone());
            current = parents.get(&current_id).cloned().flatten();
        }
        while let Some(current_id) = chain.pop() {
            let parent_path = parents
                .get(&current_id)
                .and_then(|parent| parent.as_ref())
                .and_then(|parent| resolved.get(parent))
                .cloned()
                .unwrap_or_default();
            let component = components
                .get(&current_id)
                .cloned()
                .unwrap_or_else(|| "Folder".to_owned());
            let path = if parent_path.is_empty() {
                component
            } else {
                format!("{parent_path}/{component}")
            };
            resolved.insert(current_id, path);
        }
    }
    resolved
}

fn ensure_safe_directory(root: &Path, relative: &str) -> Result<(), StorageError> {
    validate_relative_directory(relative)?;
    if relative.is_empty() {
        return Ok(());
    }
    let mut current = root.to_path_buf();
    for component in Path::new(relative).components() {
        let Component::Normal(component) = component else {
            return Err(StorageError::UnsafePath(relative.to_owned()));
        };
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(StorageError::UnsafePath(current.display().to_string()));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current).map_err(|error| io(&current, error))?;
            }
            Err(error) => return Err(io(&current, error)),
        }
    }
    let canonical = fs::canonicalize(&current).map_err(|error| io(&current, error))?;
    if !canonical.starts_with(root) {
        return Err(StorageError::UnsafePath(current.display().to_string()));
    }
    Ok(())
}

fn directory_presence_inside(root: &Path, relative: &str) -> Result<bool, StorageError> {
    let destination = root.join(path_from_directory_manifest(relative)?);
    if !validate_existing_parent(root, &destination)? {
        return Ok(false);
    }
    let metadata = match fs::symlink_metadata(&destination) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(io(&destination, error)),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(StorageError::UnsafePath(destination.display().to_string()));
    }
    let canonical = fs::canonicalize(&destination).map_err(|error| io(&destination, error))?;
    if !canonical.starts_with(root) {
        return Err(StorageError::UnsafePath(destination.display().to_string()));
    }
    Ok(true)
}

fn remove_empty_directory_inside(root: &Path, relative: &str) -> Result<bool, StorageError> {
    validate_relative_directory(relative)?;
    if relative.is_empty() {
        return Ok(false);
    }
    let destination = root.join(path_from_directory_manifest(relative)?);
    let metadata = match fs::symlink_metadata(&destination) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(io(&destination, error)),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Ok(false);
    }
    let canonical = fs::canonicalize(&destination).map_err(|error| io(&destination, error))?;
    if !canonical.starts_with(root) {
        return Err(StorageError::UnsafePath(destination.display().to_string()));
    }
    match fs::remove_dir(&destination) {
        Ok(()) => Ok(true),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
            ) =>
        {
            Ok(false)
        }
        Err(error) => Err(io(&destination, error)),
    }
}

fn allocate_path(
    root: &Path,
    note: &Note,
    manifest: &Manifest,
    owners: &HashMap<String, String>,
) -> Result<String, StorageError> {
    let directory = note
        .folder_id
        .as_ref()
        .and_then(|id| manifest.folders.get(id))
        .cloned()
        .unwrap_or_default();
    validate_relative_directory(&directory)?;
    let stem = sanitize_file_name(&note.title);
    for attempt in 1..10_000 {
        let suffix = if attempt == 1 {
            String::new()
        } else {
            format!(" {attempt}")
        };
        let filename = format!("{stem}{suffix}.md");
        let candidate = if directory.is_empty() {
            filename
        } else {
            format!("{directory}/{filename}")
        };
        validate_relative_markdown(&candidate)?;
        if owners.get(&candidate).is_some_and(|id| id != &note.id) {
            continue;
        }
        if !root.join(path_from_manifest(&candidate)?).exists() {
            return Ok(candidate);
        }
    }
    Err(StorageError::UnsafePath(
        "could not allocate collision-safe Markdown path".to_owned(),
    ))
}

fn preserve_conflict(
    root: &Path,
    source: &Path,
    relative: &str,
    now: u64,
    owners: &HashMap<String, String>,
) -> Result<Option<String>, StorageError> {
    let Some(bytes) = read_regular_limited(source, MAX_MARKDOWN_BYTES)? else {
        return Ok(None);
    };
    let original = String::from_utf8(bytes)
        .map_err(|_| StorageError::InvalidMetadata("conflict is not UTF-8".to_owned()))?;
    let without_marker = original
        .lines()
        .filter(|line| !line.starts_with(METADATA_PREFIX))
        .collect::<Vec<_>>()
        .join("\n");
    let path = Path::new(relative);
    let parent = path.parent().unwrap_or_else(|| Path::new(""));
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("note");
    for attempt in 0..1000 {
        let suffix = if attempt == 0 {
            String::new()
        } else {
            format!("-{attempt}")
        };
        let filename = format!("{stem}.stormdance-conflict-{now}{suffix}.md");
        let candidate = if parent.as_os_str().is_empty() {
            filename
        } else {
            format!("{}/{}", slash_path(parent), filename)
        };
        if owners.contains_key(&candidate) {
            continue;
        }
        let destination = root.join(path_from_manifest(&candidate)?);
        if destination.exists() {
            continue;
        }
        ensure_safe_parent(root, &destination)?;
        atomic_write(&destination, without_marker.as_bytes(), 0o644)?;
        return Ok(Some(candidate));
    }
    Err(StorageError::UnsafePath(
        "could not allocate conflict path".to_owned(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{DataChange, ModifyKind};
    use notify::EventKind;
    use tempfile::tempdir;

    fn config() -> LinkConfig {
        LinkConfig {
            schema: MIRROR_SCHEMA,
            notebook_id: "notebook-1".to_owned(),
            conversation_id: "group-1".to_owned(),
            notebook_name: "Research".to_owned(),
            profile: "default".to_owned(),
            env: Environment::Dev,
            expected_inbox_id: Some("inbox-1".to_owned()),
        }
    }

    fn note(id: &str, title: &str, folder: Option<&str>) -> Note {
        Note {
            id: id.to_owned(),
            title: title.to_owned(),
            content: "[[Other note]]\n\n#tag".to_owned(),
            folder_id: folder.map(str::to_owned),
            created_at: 1,
            updated_at: 2,
            deleted: false,
            deleted_at: None,
        }
    }

    fn folder(id: &str, name: &str, parent: Option<&str>) -> Folder {
        Folder {
            id: id.to_owned(),
            name: name.to_owned(),
            parent_folder_id: parent.map(str::to_owned),
            created_at: 1,
            updated_at: 2,
            deleted: false,
            deleted_at: None,
        }
    }

    fn snapshot(notes: Vec<Note>) -> NotebookSnapshot {
        NotebookSnapshot {
            schema_version: 1,
            notebook: NotebookSeed {
                id: "notebook-1".to_owned(),
                name: "Research".to_owned(),
                created_at: 1,
                updated_at: 2,
            },
            folders: Vec::new(),
            notes,
        }
    }

    fn snapshot_with_folders(folders: Vec<Folder>, notes: Vec<Note>) -> NotebookSnapshot {
        NotebookSnapshot {
            folders,
            ..snapshot(notes)
        }
    }

    #[test]
    fn nested_markdown_round_trips_wikilinks_and_manifest_identity() -> Result<(), StorageError> {
        let directory = tempdir().map_err(|error| io("temp", error))?;
        let mirror = Mirror::open(directory.path())?;
        mirror.write_link(&config())?;
        fs::create_dir(directory.path().join("Sources")).map_err(|error| io("Sources", error))?;
        fs::write(
            directory.path().join("Sources/libxmtp.md"),
            "---\ntags: [xmtp]\n---\n# libxmtp\n\n[[Other note]]\n",
        )
        .map_err(|error| io("libxmtp", error))?;
        let scan = mirror.scan("notebook-1")?;
        assert_eq!(scan.upserts.len(), 1);
        assert_eq!(
            scan.upserts[0].folder_id.as_deref(),
            Some("obsidian:path:notebook-1:Sources")
        );
        assert!(scan.upserts[0].content.starts_with("---\ntags:"));

        let replica = mirror.load_replica()?;
        replica.upsert_note(&scan.upserts[0])?;
        mirror.materialize_internal(
            &replica.snapshot()?,
            &scan.preferred_paths,
            &scan.witnesses,
            10,
        )?;
        let output = fs::read_to_string(directory.path().join("Sources/libxmtp.md"))
            .map_err(|error| io("libxmtp", error))?;
        assert!(output.starts_with("---\ntags: [xmtp]\n---\n<!-- stormdance:"));
        assert!(output.contains("[[Other note]]"));
        Ok(())
    }

    #[test]
    fn remote_folder_tree_creates_empty_directories_and_moves_owned_notes(
    ) -> Result<(), StorageError> {
        let directory = tempdir().map_err(|error| io("temp", error))?;
        let mirror = Mirror::open(directory.path())?;
        mirror.write_link(&config())?;
        let initial = snapshot_with_folders(
            vec![
                folder("research", "Research", None),
                folder("protocol", "Protocol", Some("research")),
                folder("empty", "Empty", None),
            ],
            vec![note("n1", "Design", Some("protocol"))],
        );
        let first = mirror.materialize(&initial, 1)?;
        assert!(directory.path().join("Empty").is_dir());
        assert!(first.manifest.notes["n1"]
            .path
            .starts_with("Research/Protocol/"));

        let moved = snapshot_with_folders(
            vec![
                folder("research", "Research", None),
                folder("protocol", "Archive", None),
                folder("empty", "Empty", None),
            ],
            vec![note("n1", "Design", Some("protocol"))],
        );
        let second = mirror.materialize(&moved, 2)?;
        assert!(second.manifest.notes["n1"].path.starts_with("Archive/"));
        assert!(!directory
            .path()
            .join(&first.manifest.notes["n1"].path)
            .exists());
        assert!(!directory.path().join("Research/Protocol").exists());
        Ok(())
    }

    #[test]
    fn idle_projected_folders_do_not_create_pending_status_changes() -> Result<(), StorageError> {
        let directory = tempdir().map_err(|error| io("temp", error))?;
        let mirror = Mirror::open(directory.path())?;
        mirror.write_link(&config())?;
        let replica = NotebookCrdt::new("notebook-1")?;
        replica.seed_with_folders(
            &snapshot(Vec::new()).notebook,
            &[folder("folder-a", "A", None)],
            &[],
        )?;
        mirror.persist_and_materialize(&replica, 1)?;

        assert_eq!(mirror.status()?.pending_local_changes, 0);
        let reconciled = mirror.reconcile(2)?;
        assert!(reconciled.scan.folder_upserts.is_empty());
        assert!(reconciled.scan.deleted_folder_ids.is_empty());
        Ok(())
    }

    #[test]
    fn legacy_manifest_folders_migrate_once_into_an_old_replica() -> Result<(), StorageError> {
        let directory = tempdir().map_err(|error| io("temp", error))?;
        let mirror = Mirror::open(directory.path())?;
        mirror.write_link(&config())?;
        fs::create_dir(directory.path().join("Research")).map_err(|error| io("Research", error))?;
        let replica = NotebookCrdt::new("notebook-1")?;
        replica.seed(&snapshot(Vec::new()).notebook, &[])?;
        mirror.write_state(&replica.encode_state_as_update_v1())?;
        let mut manifest = Manifest::default();
        manifest
            .folders
            .insert("legacy-folder".to_owned(), "Research".to_owned());
        mirror.write_manifest(&manifest)?;

        assert_eq!(mirror.status()?.pending_local_changes, 1);
        let migrated = mirror.reconcile(2)?;
        assert_eq!(migrated.scan.folder_upserts.len(), 1);
        assert_eq!(migrated.snapshot.folders[0].id, "legacy-folder");
        assert_eq!(mirror.status()?.pending_local_changes, 0);
        Ok(())
    }

    #[test]
    fn synthesized_folder_ids_match_node_and_are_notebook_scoped() -> Result<(), StorageError> {
        let directory = tempdir().map_err(|error| io("temp", error))?;
        let mirror = Mirror::open(directory.path())?;
        mirror.write_link(&config())?;
        fs::create_dir(directory.path().join("Research")).map_err(|error| io("Research", error))?;

        let first = mirror.scan("notebook:one")?;
        let first_id = &first.folder_upserts[0].id;
        assert_eq!(first_id, "obsidian:path:notebook%3Aone:Research");
        let second = mirror.scan("notebook:two")?;
        assert_ne!(first_id, &second.folder_upserts[0].id);

        let legacy_id = "obsidian:path:Research";
        let mut manifest = Manifest::default();
        manifest
            .folders
            .insert(legacy_id.to_owned(), "Research".to_owned());
        mirror.write_manifest(&manifest)?;
        fs::write(directory.path().join("Research/note.md"), "# Note\n")
            .map_err(|error| io("note.md", error))?;
        let legacy = mirror.scan("notebook:one")?;
        assert_eq!(legacy.upserts[0].folder_id.as_deref(), Some(legacy_id));
        assert!(legacy
            .folder_upserts
            .iter()
            .any(|folder| folder.id == legacy_id));
        Ok(())
    }

    #[test]
    fn colliding_parent_names_keep_descendants_under_the_final_parent_path() {
        let projection = projected_folder_paths(&snapshot_with_folders(
            vec![
                folder("a", "Shared", None),
                folder("b", "Shared", None),
                folder("child", "Child", Some("b")),
            ],
            Vec::new(),
        ));
        assert_eq!(projection["a"], "Shared");
        assert_ne!(projection["a"], projection["b"]);
        assert!(projection["child"].starts_with(&format!("{}/", projection["b"])));
        assert!(!projection["child"].starts_with(&format!("{}/", projection["a"])));
    }

    #[test]
    fn tombstoned_folder_is_not_reinserted_by_an_active_note() -> Result<(), StorageError> {
        let directory = tempdir().map_err(|error| io("temp", error))?;
        let mirror = Mirror::open(directory.path())?;
        mirror.write_link(&config())?;
        let live = folder("folder-a", "A", None);
        mirror.materialize(
            &snapshot_with_folders(
                vec![live.clone()],
                vec![note("n1", "Design", Some("folder-a"))],
            ),
            1,
        )?;
        let mut deleted = live;
        deleted.deleted = true;
        deleted.deleted_at = Some(2);
        let result = mirror.materialize(
            &snapshot_with_folders(vec![deleted], vec![note("n1", "Design", Some("folder-a"))]),
            2,
        )?;

        assert!(!result.manifest.folders.contains_key("folder-a"));
        assert_eq!(
            Path::new(&result.manifest.notes["n1"].path).parent(),
            Some(Path::new(""))
        );
        Ok(())
    }

    #[test]
    fn stale_cleanup_never_removes_a_path_reused_by_another_folder() -> Result<(), StorageError> {
        let directory = tempdir().map_err(|error| io("temp", error))?;
        let mirror = Mirror::open(directory.path())?;
        mirror.write_link(&config())?;
        mirror.materialize(
            &snapshot_with_folders(vec![folder("one", "Shared", None)], Vec::new()),
            1,
        )?;
        let result = mirror.materialize(
            &snapshot_with_folders(
                vec![folder("one", "Other", None), folder("two", "Shared", None)],
                Vec::new(),
            ),
            2,
        )?;

        assert_eq!(result.manifest.folders["one"], "Other");
        assert_eq!(result.manifest.folders["two"], "Shared");
        assert!(directory.path().join("Other").is_dir());
        assert!(directory.path().join("Shared").is_dir());
        Ok(())
    }

    #[test]
    fn folder_presence_witnesses_reject_raced_creates_and_deletes() -> Result<(), StorageError> {
        let directory = tempdir().map_err(|error| io("temp", error))?;
        let mirror = Mirror::open(directory.path())?;
        mirror.write_link(&config())?;
        fs::create_dir(directory.path().join("Racing")).map_err(|error| io("Racing", error))?;
        let mut created = mirror.scan("notebook-1")?;
        fs::remove_dir(directory.path().join("Racing")).map_err(|error| io("Racing", error))?;
        mirror.revalidate_folder_witnesses(&mut created);
        assert!(created.folder_upserts.is_empty());

        let mut manifest = Manifest::default();
        manifest
            .folders
            .insert("gone".to_owned(), "Gone".to_owned());
        mirror.write_manifest(&manifest)?;
        let mut deleted = mirror.scan("notebook-1")?;
        assert_eq!(deleted.deleted_folder_ids, vec!["gone".to_owned()]);
        fs::create_dir(directory.path().join("Gone")).map_err(|error| io("Gone", error))?;
        mirror.revalidate_folder_witnesses(&mut deleted);
        assert!(deleted.deleted_folder_ids.is_empty());
        assert!(deleted
            .ignored_paths
            .iter()
            .any(|path| path.contains("changed during folder reconciliation")));
        Ok(())
    }

    #[test]
    fn scan_projects_empty_directories_and_distinguishes_note_moves_from_folder_renames(
    ) -> Result<(), StorageError> {
        let directory = tempdir().map_err(|error| io("temp", error))?;
        let mirror = Mirror::open(directory.path())?;
        mirror.write_link(&config())?;
        let initial = snapshot_with_folders(
            vec![folder("folder-a", "A", None)],
            vec![note("n1", "Design", Some("folder-a"))],
        );
        let first = mirror.materialize(&initial, 1)?;
        fs::create_dir(directory.path().join("B")).map_err(|error| io("B", error))?;
        let old_note = directory.path().join(&first.manifest.notes["n1"].path);
        let moved_note = directory.path().join("B/design.md");
        fs::rename(&old_note, &moved_note).map_err(|error| io("move note", error))?;

        let moved_scan = mirror.scan("notebook-1")?;
        assert_eq!(
            moved_scan.upserts[0].folder_id.as_deref(),
            Some("obsidian:path:notebook-1:B")
        );
        assert!(moved_scan.folder_upserts.iter().any(|candidate| {
            candidate.id == "obsidian:path:notebook-1:B" && candidate.name == "B"
        }));

        fs::remove_dir(directory.path().join("A")).map_err(|error| io("A", error))?;
        fs::rename(directory.path().join("B"), directory.path().join("Renamed"))
            .map_err(|error| io("rename folder", error))?;
        let renamed_scan = mirror.scan_internal("notebook-1", Some(&initial))?;
        let renamed = renamed_scan
            .folder_upserts
            .iter()
            .find(|candidate| candidate.id == "folder-a" && candidate.name == "Renamed")
            .expect("renamed folder must be projected");
        assert_eq!(renamed.created_at, 1);
        assert!(renamed.updated_at > initial.folders[0].updated_at);
        Ok(())
    }

    #[test]
    fn protects_symlinks_and_ignores_obsidian_state() -> Result<(), StorageError> {
        let directory = tempdir().map_err(|error| io("temp", error))?;
        let mirror = Mirror::open(directory.path())?;
        mirror.write_link(&config())?;
        fs::create_dir(directory.path().join(".obsidian"))
            .map_err(|error| io(".obsidian", error))?;
        fs::write(directory.path().join(".obsidian/workspace.md"), "# private")
            .map_err(|error| io("workspace", error))?;
        #[cfg(unix)]
        std::os::unix::fs::symlink(
            directory.path().join(".obsidian/workspace.md"),
            directory.path().join("escape.md"),
        )
        .map_err(|error| io("escape", error))?;
        let scan = mirror.scan("notebook-1")?;
        assert!(scan.upserts.is_empty());
        Ok(())
    }

    #[test]
    fn remote_write_preserves_unsynced_local_conflict() -> Result<(), StorageError> {
        let directory = tempdir().map_err(|error| io("temp", error))?;
        let mirror = Mirror::open(directory.path())?;
        mirror.write_link(&config())?;
        let initial = snapshot(vec![note("n1", "Design", None)]);
        let first = mirror.materialize(&initial, 1)?;
        let path = first.manifest.notes["n1"].path.clone();
        fs::write(directory.path().join(&path), "# local stale edit\n")
            .map_err(|error| io(&path, error))?;
        let mut remote = initial;
        remote.notes[0].content = "remote edit".to_owned();
        remote.notes[0].updated_at = 3;
        let result = mirror.materialize(&remote, 123)?;
        assert_eq!(result.conflict_paths.len(), 1);
        assert!(directory.path().join(&result.conflict_paths[0]).exists());
        Ok(())
    }

    #[test]
    fn never_renames_an_existing_obsidian_note_when_title_changes() -> Result<(), StorageError> {
        let directory = tempdir().map_err(|error| io("temp", error))?;
        let mirror = Mirror::open(directory.path())?;
        mirror.write_link(&config())?;
        let initial = snapshot(vec![note("n1", "Old title", None)]);
        let first = mirror.materialize(&initial, 1)?;
        let path = first.manifest.notes["n1"].path.clone();
        let mut renamed = initial;
        renamed.notes[0].title = "New title".to_owned();
        let second = mirror.materialize(&renamed, 2)?;
        assert_eq!(second.manifest.notes["n1"].path, path);
        Ok(())
    }

    #[test]
    fn watcher_suppresses_only_the_exact_hash_written_by_projection() -> Result<(), StorageError> {
        let directory = tempdir().map_err(|error| io("temp", error))?;
        let mirror = Mirror::open(directory.path())?;
        mirror.write_link(&config())?;
        let result = mirror.materialize(&snapshot(vec![note("n1", "Design", None)]), 1)?;
        // Mirror::open canonicalizes the root (for example, /var becomes
        // /private/var on macOS). Build the synthetic notify event from that
        // canonical root, just as the real watcher does, so the path is not
        // discarded as outside the vault on platforms where the spelling of
        // the temporary directory changes during canonicalization.
        let path = mirror.root().join(&result.manifest.notes["n1"].path);
        let event = Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Content)))
            .add_path(path.clone());
        assert_eq!(
            classify_event(mirror.root(), &mirror.self_hashes, event),
            MirrorEvent::SelfWrite(vec![path.clone()])
        );
        fs::write(&path, "# external\n").map_err(|error| io(&path, error))?;
        let event = Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Content)))
            .add_path(path.clone());
        assert_eq!(
            classify_event(mirror.root(), &mirror.self_hashes, event),
            MirrorEvent::External(vec![path])
        );
        Ok(())
    }

    #[test]
    fn operating_system_watcher_reports_external_nested_markdown_change() -> Result<(), StorageError>
    {
        let directory = tempdir().map_err(|error| io("temp", error))?;
        let mirror = Mirror::open(directory.path())?;
        mirror.write_link(&config())?;
        fs::create_dir(directory.path().join("Research")).map_err(|error| io("Research", error))?;
        let watcher = mirror.watch()?;
        fs::write(directory.path().join("Research/new.md"), "# New\n\nbody")
            .map_err(|error| io("new.md", error))?;
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            match watcher.recv_timeout(Duration::from_millis(250)) {
                Ok(MirrorEvent::External(paths))
                    if paths.iter().any(|path| path.ends_with("Research/new.md")) =>
                {
                    return Ok(())
                }
                Ok(_) | Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(StorageError::InvalidRoot("watcher disconnected".to_owned()))
                }
            }
        }
        Err(StorageError::InvalidRoot(
            "watcher did not report nested Markdown write".to_owned(),
        ))
    }

    #[test]
    fn metadata_inside_a_fenced_code_block_is_not_claimed() -> Result<(), StorageError> {
        let source = "```html\n<!-- stormdance:{bad} -->\n```\n# Example\n\nbody\n";
        let parsed = parse_markdown(source, "notebook-1", None, "Example.md", 1)?;
        assert_eq!(parsed.title, "Example");
        assert!(parsed.content.contains("stormdance:{bad}"));
        Ok(())
    }

    #[test]
    fn windows_device_names_are_never_allocated() {
        assert_eq!(sanitize_file_name("CON"), "_CON");
        assert_eq!(sanitize_file_name("CON.txt"), "_CON.txt");
        assert_eq!(sanitize_file_name("lpt9"), "_lpt9");
        assert_eq!(sanitize_file_name("ordinary"), "ordinary");
    }

    #[test]
    fn title_extraction_ignores_yaml_comments_and_fenced_headings() -> Result<(), StorageError> {
        let source = "---\n# yaml comment\ntags: [one]\n---\n```md\n# fenced heading\n```\n# Real title\n\nbody\n";
        let parsed = parse_markdown(source, "notebook-1", None, "fallback.md", 1)?;
        assert_eq!(parsed.title, "Real title");
        assert!(parsed.content.contains("# yaml comment"));
        assert!(parsed.content.contains("# fenced heading"));
        Ok(())
    }

    #[test]
    fn missing_state_with_owned_manifest_fails_closed() -> Result<(), StorageError> {
        let directory = tempdir().map_err(|error| io("temp", error))?;
        let mirror = Mirror::open(directory.path())?;
        mirror.write_link(&config())?;
        mirror.materialize(&snapshot(vec![note("n1", "Owned", None)]), 1)?;
        assert!(matches!(
            mirror.load_replica(),
            Err(StorageError::InvalidManifest(_))
        ));
        Ok(())
    }

    #[test]
    fn changed_scan_witness_preserves_the_newer_file_as_a_conflict() -> Result<(), StorageError> {
        let directory = tempdir().map_err(|error| io("temp", error))?;
        let mirror = Mirror::open(directory.path())?;
        mirror.write_link(&config())?;
        let replica = NotebookCrdt::new("notebook-1")?;
        let initial = snapshot(vec![note("n1", "Witness", None)]);
        replica.seed(&initial.notebook, &initial.notes)?;
        let first = mirror.persist_and_materialize(&replica, 1)?;
        let relative = first.manifest.notes["n1"].path.clone();
        let destination = directory.path().join(&relative);
        fs::write(&destination, "# Witness\n\nfirst local save")
            .map_err(|error| io(&destination, error))?;
        let scan = mirror.scan("notebook-1")?;
        assert_eq!(scan.upserts.len(), 1);
        replica.upsert_note(&scan.upserts[0])?;
        fs::write(&destination, "# Witness\n\nnewer local save")
            .map_err(|error| io(&destination, error))?;

        let result = mirror.materialize_internal(
            &replica.snapshot()?,
            &scan.preferred_paths,
            &scan.witnesses,
            77,
        )?;
        assert_eq!(result.conflict_paths.len(), 1);
        let conflict = fs::read_to_string(directory.path().join(&result.conflict_paths[0]))
            .map_err(|error| io("conflict", error))?;
        assert!(conflict.contains("newer local save"));
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlinked_parent_before_atomic_write() -> Result<(), StorageError> {
        let directory = tempdir().map_err(|error| io("temp", error))?;
        let outside = tempdir().map_err(|error| io("outside", error))?;
        std::os::unix::fs::symlink(outside.path(), directory.path().join("linked"))
            .map_err(|error| io("linked", error))?;
        assert!(matches!(
            ensure_safe_parent(directory.path(), &directory.path().join("linked/note.md")),
            Err(StorageError::UnsafePath(_))
        ));
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_managed_parent_never_tombstones_or_deletes_outside() -> Result<(), StorageError> {
        let directory = tempdir().map_err(|error| io("temp", error))?;
        let outside = tempdir().map_err(|error| io("outside", error))?;
        let mirror = Mirror::open(directory.path())?;
        mirror.write_link(&config())?;
        fs::create_dir(directory.path().join("Nested")).map_err(|error| io("Nested", error))?;
        fs::write(directory.path().join("Nested/note.md"), "# Safe\n\ninside")
            .map_err(|error| io("note", error))?;
        let initial = mirror.reconcile(1)?;
        let note_id = initial.snapshot.notes[0].id.clone();
        fs::remove_file(directory.path().join("Nested/note.md"))
            .map_err(|error| io("note", error))?;
        fs::remove_dir(directory.path().join("Nested")).map_err(|error| io("Nested", error))?;
        fs::write(outside.path().join("note.md"), "outside must survive")
            .map_err(|error| io("outside note", error))?;
        std::os::unix::fs::symlink(outside.path(), directory.path().join("Nested"))
            .map_err(|error| io("Nested link", error))?;

        let reconciled = mirror.reconcile(2)?;
        assert!(reconciled.scan.deleted_note_ids.is_empty());
        assert!(reconciled
            .snapshot
            .notes
            .iter()
            .any(|note| note.id == note_id && !note.deleted));
        assert_eq!(
            fs::read_to_string(outside.path().join("note.md"))
                .map_err(|error| io("outside note", error))?,
            "outside must survive"
        );
        Ok(())
    }
}
