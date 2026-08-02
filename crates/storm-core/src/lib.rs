//! Runtime-independent notebook model shared by the CLI, daemon, and Tauri.
//!
//! The names and value types in this module are a wire contract with the web
//! client. Changing them requires new cross-language fixtures.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use yrs::{
    updates::decoder::Decode, updates::encoder::Encode, Any, Doc, GetString, Map, MapPrelim,
    MapRef, OffsetKind, Options, Out, ReadTxn, StateVector, Text, TextPrelim, TextRef, Transact,
    Update,
};

pub const NOTEBOOK_CRDT_SCHEMA_VERSION: u32 = 1;
pub const NOTEBOOK_MAP_NAME: &str = "notebook";
pub const NOTES_MAP_NAME: &str = "notes";
pub const FOLDERS_MAP_NAME: &str = "folders";

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("{0} must not be empty")]
    Empty(&'static str),
    #[error("{0} must be a finite non-negative JavaScript-safe integer")]
    InvalidTimestamp(&'static str),
    #[error("document belongs to notebook {actual}, not {expected}")]
    NotebookMismatch { expected: String, actual: String },
    #[error("invalid Yjs v1 update: {0}")]
    InvalidUpdate(String),
    #[error("invalid Yjs v1 state vector: {0}")]
    InvalidStateVector(String),
    #[error("invalid notebook CRDT document: {0}")]
    InvalidDocument(String),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookSeed {
    pub id: String,
    pub name: String,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub title: String,
    pub content: String,
    pub folder_id: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub deleted: bool,
    #[serde(default)]
    pub deleted_at: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: String,
    pub name: String,
    pub parent_folder_id: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub deleted: bool,
    #[serde(default)]
    pub deleted_at: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookSnapshot {
    pub schema_version: u32,
    pub notebook: NotebookSeed,
    #[serde(default)]
    pub folders: Vec<Folder>,
    pub notes: Vec<Note>,
}

/// A single-splice edit expressed in Yjs/Yrs UTF-16 offsets.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TextDiff {
    pub index: u32,
    pub delete_count: u32,
    pub insert: String,
}

fn require_text(value: &str, name: &'static str) -> Result<(), CoreError> {
    if value.trim().is_empty() {
        Err(CoreError::Empty(name))
    } else {
        Ok(())
    }
}

fn require_timestamp(value: u64, name: &'static str) -> Result<(), CoreError> {
    // Number.MAX_SAFE_INTEGER: timestamps must round-trip through JS Number.
    if value <= 9_007_199_254_740_991 {
        Ok(())
    } else {
        Err(CoreError::InvalidTimestamp(name))
    }
}

fn number(value: u64) -> f64 {
    value as f64
}

fn out_string(value: Option<Out>) -> Option<String> {
    match value {
        Some(Out::Any(Any::String(value))) => Some(value.to_string()),
        _ => None,
    }
}

fn out_number(value: Option<Out>) -> Option<u64> {
    match value {
        Some(Out::Any(Any::Number(value)))
            if value.is_finite()
                && value.fract() == 0.0
                && (0.0..=9_007_199_254_740_991.0).contains(&value) =>
        {
            Some(value as u64)
        }
        _ => None,
    }
}

fn required_string(value: Option<Out>, field: &str) -> Result<String, CoreError> {
    out_string(value).ok_or_else(|| CoreError::InvalidDocument(format!("{field} must be a string")))
}

fn required_timestamp(value: Option<Out>, field: &str) -> Result<u64, CoreError> {
    out_number(value).ok_or_else(|| {
        CoreError::InvalidDocument(format!(
            "{field} must be a finite non-negative JavaScript-safe integer"
        ))
    })
}

fn out_bool(value: Option<Out>) -> Option<bool> {
    match value {
        Some(Out::Any(Any::Bool(value))) => Some(value),
        _ => None,
    }
}

fn out_optional_string(value: Option<Out>) -> Option<String> {
    out_string(value)
}

fn out_optional_number(value: Option<Out>) -> Option<u64> {
    out_number(value)
}

fn as_map(value: Option<Out>) -> Option<MapRef> {
    value.and_then(|value| value.cast::<MapRef>().ok())
}

fn as_text(value: Option<Out>) -> Option<TextRef> {
    value.and_then(|value| value.cast::<TextRef>().ok())
}

fn utf16_len(value: impl Iterator<Item = char>) -> u32 {
    value.map(|character| character.len_utf16() as u32).sum()
}

/// Computes the same longest-prefix/suffix splice used by the TypeScript web
/// client, without splitting Unicode scalar values.
pub fn compute_minimal_string_diff(current: &str, next: &str) -> Option<TextDiff> {
    if current == next {
        return None;
    }
    let current_chars: Vec<char> = current.chars().collect();
    let next_chars: Vec<char> = next.chars().collect();
    let mut prefix = 0;
    while prefix < current_chars.len().min(next_chars.len())
        && current_chars[prefix] == next_chars[prefix]
    {
        prefix += 1;
    }

    let mut suffix = 0;
    let max_suffix = (current_chars.len() - prefix).min(next_chars.len() - prefix);
    while suffix < max_suffix
        && current_chars[current_chars.len() - 1 - suffix]
            == next_chars[next_chars.len() - 1 - suffix]
    {
        suffix += 1;
    }

    let current_end = current_chars.len() - suffix;
    let next_end = next_chars.len() - suffix;
    Some(TextDiff {
        index: utf16_len(current_chars[..prefix].iter().copied()),
        delete_count: utf16_len(current_chars[prefix..current_end].iter().copied()),
        insert: next_chars[prefix..next_end].iter().collect(),
    })
}

fn replace_text(txn: &mut yrs::TransactionMut<'_>, text: &TextRef, next: &str) {
    let current = text.get_string(txn);
    if let Some(diff) = compute_minimal_string_diff(&current, next) {
        if diff.delete_count > 0 {
            text.remove_range(txn, diff.index, diff.delete_count);
        }
        if !diff.insert.is_empty() {
            text.insert(txn, diff.index, &diff.insert);
        }
    }
}

fn get_or_insert_text(
    txn: &mut yrs::TransactionMut<'_>,
    note: &MapRef,
    key: &'static str,
) -> TextRef {
    as_text(note.get(txn, key)).unwrap_or_else(|| note.insert(txn, key, TextPrelim::new("")))
}

/// Native replica of the browser's `NotebookCrdt` Y.Doc layout.
pub struct NotebookCrdt {
    doc: Doc,
    notebook_id: String,
    metadata: MapRef,
    folders: MapRef,
    notes: MapRef,
}

impl std::fmt::Debug for NotebookCrdt {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("NotebookCrdt")
            .field("notebook_id", &self.notebook_id)
            .finish_non_exhaustive()
    }
}

impl NotebookCrdt {
    pub fn new(notebook_id: impl Into<String>) -> Result<Self, CoreError> {
        let notebook_id = notebook_id.into();
        require_text(&notebook_id, "notebook_id")?;
        let options = Options {
            offset_kind: OffsetKind::Utf16,
            ..Options::default()
        };
        let doc = Doc::with_options(options);
        let metadata = doc.get_or_insert_map(NOTEBOOK_MAP_NAME);
        let folders = doc.get_or_insert_map(FOLDERS_MAP_NAME);
        let notes = doc.get_or_insert_map(NOTES_MAP_NAME);
        Ok(Self {
            doc,
            notebook_id,
            metadata,
            folders,
            notes,
        })
    }

    pub fn from_update(notebook_id: impl Into<String>, update: &[u8]) -> Result<Self, CoreError> {
        let replica = Self::new(notebook_id)?;
        replica.apply_update_v1(update)?;
        Ok(replica)
    }

    pub fn notebook_id(&self) -> &str {
        &self.notebook_id
    }

    pub fn seed(&self, notebook: &NotebookSeed, notes: &[Note]) -> Result<(), CoreError> {
        self.seed_with_folders(notebook, &[], notes)
    }

    pub fn seed_with_folders(
        &self,
        notebook: &NotebookSeed,
        folders: &[Folder],
        notes: &[Note],
    ) -> Result<(), CoreError> {
        if notebook.id != self.notebook_id {
            return Err(CoreError::NotebookMismatch {
                expected: self.notebook_id.clone(),
                actual: notebook.id.clone(),
            });
        }
        require_text(&notebook.name, "notebook.name")?;
        require_timestamp(notebook.created_at, "notebook.created_at")?;
        require_timestamp(notebook.updated_at, "notebook.updated_at")?;

        let mut txn = self.doc.transact_mut();
        self.metadata.insert(
            &mut txn,
            "schemaVersion",
            NOTEBOOK_CRDT_SCHEMA_VERSION as f64,
        );
        self.metadata.insert(&mut txn, "id", notebook.id.clone());
        self.metadata
            .insert(&mut txn, "name", notebook.name.clone());
        if self.metadata.get(&txn, "createdAt").is_none() {
            self.metadata
                .insert(&mut txn, "createdAt", number(notebook.created_at));
        }
        self.metadata
            .insert(&mut txn, "updatedAt", number(notebook.updated_at));
        for folder in folders {
            self.upsert_folder_in_txn(&mut txn, folder, true)?;
        }
        for note in notes {
            self.upsert_note_in_txn(&mut txn, note, true)?;
        }
        Ok(())
    }

    pub fn upsert_folder(&self, folder: &Folder) -> Result<(), CoreError> {
        let mut txn = self.doc.transact_mut();
        self.upsert_folder_in_txn(&mut txn, folder, false)
    }

    fn upsert_folder_in_txn(
        &self,
        txn: &mut yrs::TransactionMut<'_>,
        folder: &Folder,
        seed_mode: bool,
    ) -> Result<(), CoreError> {
        require_text(&folder.id, "folder.id")?;
        require_text(&folder.name, "folder.name")?;
        if let Some(parent_folder_id) = &folder.parent_folder_id {
            require_text(parent_folder_id, "folder.parent_folder_id")?;
        }
        require_timestamp(folder.created_at, "folder.created_at")?;
        require_timestamp(folder.updated_at, "folder.updated_at")?;
        if let Some(deleted_at) = folder.deleted_at {
            require_timestamp(deleted_at, "folder.deleted_at")?;
        }

        let existing = as_map(self.folders.get(txn, &folder.id));
        let is_new = existing.is_none();
        let folder_map = existing.unwrap_or_else(|| {
            self.folders
                .insert(txn, folder.id.clone(), MapPrelim::default())
        });
        let name = get_or_insert_text(txn, &folder_map, "name");
        replace_text(txn, &name, &folder.name);
        match &folder.parent_folder_id {
            Some(parent_folder_id) => {
                folder_map.insert(txn, "parentFolderId", parent_folder_id.clone());
            }
            None => {
                folder_map.insert(txn, "parentFolderId", Any::Null);
            }
        }
        if is_new || folder_map.get(txn, "createdAt").is_none() {
            folder_map.insert(txn, "createdAt", number(folder.created_at));
        }
        folder_map.insert(txn, "updatedAt", number(folder.updated_at));

        if is_new || !seed_mode || folder.deleted {
            folder_map.insert(txn, "deleted", folder.deleted);
            match folder.deleted_at {
                Some(value) => folder_map.insert(txn, "deletedAt", number(value)),
                None => folder_map.insert(txn, "deletedAt", Any::Null),
            };
        }
        Ok(())
    }

    pub fn delete_folder(&self, folder_id: &str, deleted_at: u64) -> Result<(), CoreError> {
        require_text(folder_id, "folder_id")?;
        require_timestamp(deleted_at, "deleted_at")?;
        let mut txn = self.doc.transact_mut();
        if let Some(folder) = as_map(self.folders.get(&txn, folder_id)) {
            folder.insert(&mut txn, "deleted", true);
            folder.insert(&mut txn, "deletedAt", number(deleted_at));
            folder.insert(&mut txn, "updatedAt", number(deleted_at));
        }
        Ok(())
    }

    pub fn update_notebook(&self, name: Option<&str>, updated_at: u64) -> Result<(), CoreError> {
        require_timestamp(updated_at, "updated_at")?;
        if let Some(name) = name {
            require_text(name, "name")?;
        }
        let mut txn = self.doc.transact_mut();
        if let Some(name) = name {
            self.metadata.insert(&mut txn, "name", name.to_owned());
        }
        self.metadata
            .insert(&mut txn, "updatedAt", number(updated_at));
        Ok(())
    }

    pub fn upsert_note(&self, note: &Note) -> Result<(), CoreError> {
        let mut txn = self.doc.transact_mut();
        self.upsert_note_in_txn(&mut txn, note, false)
    }

    fn upsert_note_in_txn(
        &self,
        txn: &mut yrs::TransactionMut<'_>,
        note: &Note,
        seed_mode: bool,
    ) -> Result<(), CoreError> {
        require_text(&note.id, "note.id")?;
        require_timestamp(note.created_at, "note.created_at")?;
        require_timestamp(note.updated_at, "note.updated_at")?;
        if let Some(deleted_at) = note.deleted_at {
            require_timestamp(deleted_at, "note.deleted_at")?;
        }

        let existing = as_map(self.notes.get(txn, &note.id));
        let is_new = existing.is_none();
        let note_map = existing.unwrap_or_else(|| {
            self.notes
                .insert(txn, note.id.clone(), MapPrelim::default())
        });
        let title = get_or_insert_text(txn, &note_map, "title");
        let content = get_or_insert_text(txn, &note_map, "content");
        replace_text(txn, &title, &note.title);
        replace_text(txn, &content, &note.content);
        match &note.folder_id {
            Some(folder_id) => {
                note_map.insert(txn, "folderId", folder_id.clone());
            }
            None => {
                note_map.insert(txn, "folderId", Any::Null);
            }
        }
        if is_new || note_map.get(txn, "createdAt").is_none() {
            note_map.insert(txn, "createdAt", number(note.created_at));
        }
        note_map.insert(txn, "updatedAt", number(note.updated_at));

        // Seeding must not accidentally resurrect a persisted tombstone. A
        // normal filesystem upsert is an explicit restore.
        if is_new || !seed_mode || note.deleted {
            note_map.insert(txn, "deleted", note.deleted);
            match note.deleted_at {
                Some(value) => note_map.insert(txn, "deletedAt", number(value)),
                None => note_map.insert(txn, "deletedAt", Any::Null),
            };
        }
        Ok(())
    }

    pub fn delete_note(&self, note_id: &str, deleted_at: u64) -> Result<(), CoreError> {
        require_text(note_id, "note_id")?;
        require_timestamp(deleted_at, "deleted_at")?;
        let mut txn = self.doc.transact_mut();
        if let Some(note) = as_map(self.notes.get(&txn, note_id)) {
            note.insert(&mut txn, "deleted", true);
            note.insert(&mut txn, "deletedAt", number(deleted_at));
            note.insert(&mut txn, "updatedAt", number(deleted_at));
        }
        Ok(())
    }

    pub fn snapshot(&self) -> Result<NotebookSnapshot, CoreError> {
        let txn = self.doc.transact();
        let stored_id =
            out_string(self.metadata.get(&txn, "id")).unwrap_or_else(|| self.notebook_id.clone());
        if stored_id != self.notebook_id {
            return Err(CoreError::NotebookMismatch {
                expected: self.notebook_id.clone(),
                actual: stored_id,
            });
        }
        let notebook = NotebookSeed {
            id: self.notebook_id.clone(),
            name: out_string(self.metadata.get(&txn, "name")).unwrap_or_default(),
            created_at: out_number(self.metadata.get(&txn, "createdAt")).unwrap_or_default(),
            updated_at: out_number(self.metadata.get(&txn, "updatedAt")).unwrap_or_default(),
        };
        let mut folders = Vec::new();
        for (id, value) in self.folders.iter(&txn) {
            let Some(folder) = value.cast::<MapRef>().ok() else {
                continue;
            };
            folders.push(Folder {
                id: id.to_string(),
                name: as_text(folder.get(&txn, "name"))
                    .map(|text| text.get_string(&txn))
                    .unwrap_or_default(),
                parent_folder_id: out_optional_string(folder.get(&txn, "parentFolderId")),
                created_at: out_number(folder.get(&txn, "createdAt")).unwrap_or_default(),
                updated_at: out_number(folder.get(&txn, "updatedAt")).unwrap_or_default(),
                deleted: out_bool(folder.get(&txn, "deleted")).unwrap_or(false),
                deleted_at: out_optional_number(folder.get(&txn, "deletedAt")),
            });
        }
        folders.sort_by(|left, right| left.id.cmp(&right.id));
        let active: BTreeSet<String> = folders
            .iter()
            .filter(|folder| !folder.deleted)
            .map(|folder| folder.id.clone())
            .collect();
        let mut parents: BTreeMap<String, Option<String>> = folders
            .iter()
            .map(|folder| {
                let parent = folder
                    .parent_folder_id
                    .as_ref()
                    .filter(|parent| *parent != &folder.id && active.contains(*parent))
                    .cloned();
                (folder.id.clone(), parent)
            })
            .collect();
        let mut visited = BTreeSet::new();
        for folder in &folders {
            if folder.deleted || visited.contains(&folder.id) {
                continue;
            }
            let mut path = Vec::<String>::new();
            let mut indexes = HashMap::<String, usize>::new();
            let mut current = Some(folder.id.clone());
            while let Some(id) = current {
                if !active.contains(&id) || visited.contains(&id) {
                    break;
                }
                if let Some(cycle_start) = indexes.get(&id).copied() {
                    if let Some(root) = path[cycle_start..].iter().min().cloned() {
                        parents.insert(root, None);
                    }
                    break;
                }
                indexes.insert(id.clone(), path.len());
                path.push(id.clone());
                current = parents.get(&id).cloned().flatten();
            }
            visited.extend(path);
        }
        for folder in &mut folders {
            folder.parent_folder_id = parents.remove(&folder.id).flatten();
        }
        let mut notes = Vec::new();
        for (id, value) in self.notes.iter(&txn) {
            let Some(note) = value.cast::<MapRef>().ok() else {
                continue;
            };
            notes.push(Note {
                id: id.to_string(),
                title: as_text(note.get(&txn, "title"))
                    .map(|text| text.get_string(&txn))
                    .unwrap_or_default(),
                content: as_text(note.get(&txn, "content"))
                    .map(|text| text.get_string(&txn))
                    .unwrap_or_default(),
                folder_id: out_optional_string(note.get(&txn, "folderId")),
                created_at: out_number(note.get(&txn, "createdAt")).unwrap_or_default(),
                updated_at: out_number(note.get(&txn, "updatedAt")).unwrap_or_default(),
                deleted: out_bool(note.get(&txn, "deleted")).unwrap_or(false),
                deleted_at: out_optional_number(note.get(&txn, "deletedAt")),
            });
        }
        notes.sort_by(|left, right| left.id.cmp(&right.id));
        Ok(NotebookSnapshot {
            schema_version: NOTEBOOK_CRDT_SCHEMA_VERSION,
            notebook,
            folders,
            notes,
        })
    }

    pub fn encode_state_as_update_v1(&self) -> Vec<u8> {
        self.doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default())
    }

    pub fn encode_state_vector_v1(&self) -> Vec<u8> {
        self.doc.transact().state_vector().encode_v1()
    }

    pub fn encode_diff_v1(&self, remote_state_vector: &[u8]) -> Result<Vec<u8>, CoreError> {
        let state_vector = StateVector::decode_v1(remote_state_vector)
            .map_err(|error| CoreError::InvalidStateVector(error.to_string()))?;
        Ok(self.doc.transact().encode_state_as_update_v1(&state_vector))
    }

    pub fn apply_update_v1(&self, bytes: &[u8]) -> Result<(), CoreError> {
        // Yrs transactions cannot be rolled back after a structurally valid
        // update has begun integrating. Validate against an isolated replica
        // first so a wrong-notebook or malformed shared layout cannot partially
        // contaminate the durable document.
        let candidate = Self::new(&self.notebook_id)?;
        candidate.apply_update_v1_unchecked(&self.encode_state_as_update_v1())?;
        candidate.apply_update_v1_unchecked(bytes)?;
        candidate.validate_document()?;

        self.apply_update_v1_unchecked(bytes)
    }

    fn apply_update_v1_unchecked(&self, bytes: &[u8]) -> Result<(), CoreError> {
        let update = Update::decode_v1(bytes)
            .map_err(|error| CoreError::InvalidUpdate(error.to_string()))?;
        self.doc
            .transact_mut()
            .apply_update(update)
            .map_err(|error| CoreError::InvalidUpdate(error.to_string()))
    }

    fn validate_document(&self) -> Result<(), CoreError> {
        let txn = self.doc.transact();
        let schema_version = required_timestamp(
            self.metadata.get(&txn, "schemaVersion"),
            "notebook.schemaVersion",
        )?;
        if schema_version != NOTEBOOK_CRDT_SCHEMA_VERSION as u64 {
            return Err(CoreError::InvalidDocument(format!(
                "unsupported notebook.schemaVersion {schema_version}"
            )));
        }

        let actual = required_string(self.metadata.get(&txn, "id"), "notebook.id")?;
        if actual != self.notebook_id {
            return Err(CoreError::NotebookMismatch {
                expected: self.notebook_id.clone(),
                actual,
            });
        }
        let name = required_string(self.metadata.get(&txn, "name"), "notebook.name")?;
        if name.trim().is_empty() {
            return Err(CoreError::InvalidDocument(
                "notebook.name must not be empty".to_owned(),
            ));
        }
        required_timestamp(self.metadata.get(&txn, "createdAt"), "notebook.createdAt")?;
        required_timestamp(self.metadata.get(&txn, "updatedAt"), "notebook.updatedAt")?;

        for (id, value) in self.folders.iter(&txn) {
            if id.trim().is_empty() {
                return Err(CoreError::InvalidDocument(
                    "folder map contains an empty ID".to_owned(),
                ));
            }
            let folder = value
                .cast::<MapRef>()
                .map_err(|_| CoreError::InvalidDocument(format!("folders.{id} must be a Y.Map")))?;
            let name = as_text(folder.get(&txn, "name")).ok_or_else(|| {
                CoreError::InvalidDocument(format!("folders.{id}.name must be a Y.Text"))
            })?;
            if name.get_string(&txn).trim().is_empty() {
                return Err(CoreError::InvalidDocument(format!(
                    "folders.{id}.name must not be empty"
                )));
            }
            match folder.get(&txn, "parentFolderId") {
                Some(Out::Any(Any::String(_))) | Some(Out::Any(Any::Null)) => {}
                _ => {
                    return Err(CoreError::InvalidDocument(format!(
                        "folders.{id}.parentFolderId must be a string or null"
                    )))
                }
            }
            required_timestamp(
                folder.get(&txn, "createdAt"),
                &format!("folders.{id}.createdAt"),
            )?;
            required_timestamp(
                folder.get(&txn, "updatedAt"),
                &format!("folders.{id}.updatedAt"),
            )?;
            match folder.get(&txn, "deleted") {
                None | Some(Out::Any(Any::Bool(_))) => {}
                _ => {
                    return Err(CoreError::InvalidDocument(format!(
                        "folders.{id}.deleted must be a boolean when present"
                    )))
                }
            }
            match folder.get(&txn, "deletedAt") {
                None | Some(Out::Any(Any::Null)) => {}
                value => {
                    required_timestamp(value, &format!("folders.{id}.deletedAt"))?;
                }
            }
        }

        for (id, value) in self.notes.iter(&txn) {
            if id.trim().is_empty() {
                return Err(CoreError::InvalidDocument(
                    "note map contains an empty ID".to_owned(),
                ));
            }
            let note = value
                .cast::<MapRef>()
                .map_err(|_| CoreError::InvalidDocument(format!("notes.{id} must be a Y.Map")))?;
            for field in ["title", "content"] {
                if as_text(note.get(&txn, field)).is_none() {
                    return Err(CoreError::InvalidDocument(format!(
                        "notes.{id}.{field} must be a Y.Text"
                    )));
                }
            }
            match note.get(&txn, "folderId") {
                Some(Out::Any(Any::String(_))) | Some(Out::Any(Any::Null)) => {}
                _ => {
                    return Err(CoreError::InvalidDocument(format!(
                        "notes.{id}.folderId must be a string or null"
                    )))
                }
            }
            required_timestamp(
                note.get(&txn, "createdAt"),
                &format!("notes.{id}.createdAt"),
            )?;
            required_timestamp(
                note.get(&txn, "updatedAt"),
                &format!("notes.{id}.updatedAt"),
            )?;
            match note.get(&txn, "deleted") {
                None | Some(Out::Any(Any::Bool(_))) => {}
                _ => {
                    return Err(CoreError::InvalidDocument(format!(
                        "notes.{id}.deleted must be a boolean when present"
                    )))
                }
            }
            match note.get(&txn, "deletedAt") {
                None | Some(Out::Any(Any::Null)) => {}
                value => {
                    required_timestamp(value, &format!("notes.{id}.deletedAt"))?;
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed(id: &str) -> NotebookSeed {
        NotebookSeed {
            id: id.to_owned(),
            name: "Research".to_owned(),
            created_at: 1,
            updated_at: 2,
        }
    }

    fn note(id: &str, content: &str) -> Note {
        Note {
            id: id.to_owned(),
            title: "XMTP design".to_owned(),
            content: content.to_owned(),
            folder_id: Some("protocol".to_owned()),
            created_at: 3,
            updated_at: 4,
            deleted: false,
            deleted_at: None,
        }
    }

    fn folder(id: &str, name: &str, parent_folder_id: Option<&str>) -> Folder {
        Folder {
            id: id.to_owned(),
            name: name.to_owned(),
            parent_folder_id: parent_folder_id.map(str::to_owned),
            created_at: 1,
            updated_at: 2,
            deleted: false,
            deleted_at: None,
        }
    }

    #[test]
    fn utf16_diff_never_splits_an_emoji() {
        assert_eq!(
            compute_minimal_string_diff("a🦀b", "a🦀!b"),
            Some(TextDiff {
                index: 3,
                delete_count: 0,
                insert: "!".to_owned(),
            })
        );
    }

    #[test]
    fn v1_update_and_state_vector_converge() -> Result<(), CoreError> {
        let left = NotebookCrdt::new("notebook-1")?;
        left.seed_with_folders(
            &seed("notebook-1"),
            &[folder("folder-1", "Plans", None)],
            &[note("note-1", "base")],
        )?;
        let right = NotebookCrdt::from_update("notebook-1", &left.encode_state_as_update_v1())?;

        left.upsert_note(&note("note-1", "left edit"))?;
        right.upsert_folder(&folder("folder-2", "Archive", Some("folder-1")))?;
        let right_vector = right.encode_state_vector_v1();
        right.apply_update_v1(&left.encode_diff_v1(&right_vector)?)?;
        let left_vector = left.encode_state_vector_v1();
        left.apply_update_v1(&right.encode_diff_v1(&left_vector)?)?;
        assert_eq!(left.snapshot()?, right.snapshot()?);
        Ok(())
    }

    #[test]
    fn folder_tombstone_survives_local_seed() -> Result<(), CoreError> {
        let replica = NotebookCrdt::new("notebook-1")?;
        let original = folder("folder-1", "Plans", None);
        replica.seed_with_folders(&seed("notebook-1"), &[original.clone()], &[])?;
        replica.delete_folder("folder-1", 20)?;
        replica.seed_with_folders(
            &seed("notebook-1"),
            &[Folder {
                name: "Stale plans".to_owned(),
                updated_at: 30,
                ..original
            }],
            &[],
        )?;

        let projected = &replica.snapshot()?.folders[0];
        assert!(projected.deleted);
        assert_eq!(projected.deleted_at, Some(20));
        assert_eq!(projected.name, "Stale plans");
        Ok(())
    }

    #[test]
    fn folder_projection_normalizes_invalid_parents_and_cycles_like_the_browser(
    ) -> Result<(), CoreError> {
        let replica = NotebookCrdt::new("notebook-1")?;
        let mut deleted = folder("deleted", "Deleted", None);
        deleted.deleted = true;
        deleted.deleted_at = Some(3);
        replica.seed_with_folders(
            &seed("notebook-1"),
            &[
                folder("missing-child", "Missing", Some("absent")),
                folder("self", "Self", Some("self")),
                deleted,
                folder("deleted-child", "Deleted child", Some("deleted")),
                folder("é", "Unicode", Some("z")),
                folder("z", "ASCII", Some("é")),
            ],
            &[],
        )?;

        let projected: BTreeMap<String, Option<String>> = replica
            .snapshot()?
            .folders
            .into_iter()
            .map(|folder| (folder.id, folder.parent_folder_id))
            .collect();
        assert_eq!(projected["missing-child"], None);
        assert_eq!(projected["self"], None);
        assert_eq!(projected["deleted-child"], None);
        // UTF-8 byte order puts ASCII `z` before the leading byte of `é`.
        assert_eq!(projected["z"], None);
        assert_eq!(projected["é"].as_deref(), Some("z"));
        Ok(())
    }

    #[test]
    fn tombstone_survives_local_seed() -> Result<(), CoreError> {
        let first = NotebookCrdt::new("notebook-1")?;
        first.seed(&seed("notebook-1"), &[note("note-1", "base")])?;
        first.delete_note("note-1", 20)?;
        first.seed(&seed("notebook-1"), &[note("note-1", "stale projection")])?;
        assert!(first.snapshot()?.notes[0].deleted);
        Ok(())
    }

    #[test]
    fn rejects_cross_notebook_state() -> Result<(), CoreError> {
        let first = NotebookCrdt::new("one")?;
        first.seed(&seed("one"), &[])?;
        let error = NotebookCrdt::from_update("two", &first.encode_state_as_update_v1())
            .expect_err("must reject mismatched notebook IDs");
        assert!(matches!(error, CoreError::NotebookMismatch { .. }));
        Ok(())
    }

    #[test]
    fn rejects_a_causal_notebook_id_change_without_mutating_state() -> Result<(), CoreError> {
        let target = NotebookCrdt::new("notebook-1")?;
        target.seed(&seed("notebook-1"), &[note("note-1", "base")])?;
        let before_vector = target.encode_state_vector_v1();
        let before_snapshot = target.snapshot()?;

        let malformed =
            NotebookCrdt::from_update("notebook-1", &target.encode_state_as_update_v1())?;
        malformed.metadata.insert(
            &mut malformed.doc.transact_mut(),
            "id",
            "different-notebook",
        );
        let update = malformed.encode_diff_v1(&before_vector)?;
        assert!(matches!(
            target.apply_update_v1(&update),
            Err(CoreError::NotebookMismatch { .. })
        ));
        assert_eq!(target.encode_state_vector_v1(), before_vector);
        assert_eq!(target.snapshot()?, before_snapshot);
        Ok(())
    }

    #[test]
    fn rejects_invalid_schema_and_fractional_timestamps_before_mutation() -> Result<(), CoreError> {
        let target = NotebookCrdt::new("notebook-1")?;
        target.seed(&seed("notebook-1"), &[note("note-1", "base")])?;
        let before_vector = target.encode_state_vector_v1();
        let before_snapshot = target.snapshot()?;

        for (field, value) in [("schemaVersion", 2.0), ("updatedAt", 4.5)] {
            let malformed =
                NotebookCrdt::from_update("notebook-1", &target.encode_state_as_update_v1())?;
            malformed
                .metadata
                .insert(&mut malformed.doc.transact_mut(), field, value);
            let update = malformed.encode_diff_v1(&before_vector)?;
            assert!(matches!(
                target.apply_update_v1(&update),
                Err(CoreError::InvalidDocument(_))
            ));
            assert_eq!(target.encode_state_vector_v1(), before_vector);
            assert_eq!(target.snapshot()?, before_snapshot);
        }
        Ok(())
    }

    #[test]
    fn rejects_a_non_text_note_field_before_mutation() -> Result<(), CoreError> {
        let target = NotebookCrdt::new("notebook-1")?;
        target.seed(&seed("notebook-1"), &[note("note-1", "base")])?;
        let before_vector = target.encode_state_vector_v1();
        let before_snapshot = target.snapshot()?;

        let malformed =
            NotebookCrdt::from_update("notebook-1", &target.encode_state_as_update_v1())?;
        let mut txn = malformed.doc.transact_mut();
        let malformed_note =
            as_map(malformed.notes.get(&txn, "note-1")).expect("fixture note must remain a map");
        malformed_note.insert(&mut txn, "title", "not a Y.Text");
        drop(txn);
        let update = malformed.encode_diff_v1(&before_vector)?;
        assert!(matches!(
            target.apply_update_v1(&update),
            Err(CoreError::InvalidDocument(_))
        ));
        assert_eq!(target.encode_state_vector_v1(), before_vector);
        assert_eq!(target.snapshot()?, before_snapshot);
        Ok(())
    }
}
