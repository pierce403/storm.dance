use std::{
    env, fs,
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, bail, Context, Result};
use clap::{Args, Parser, Subcommand, ValueEnum};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use storm_core::NotebookCrdt;
use storm_storage::{Environment, LinkConfig, Mirror, MirrorEvent, MIRROR_SCHEMA};
use storm_xmtp::LIBXMTP_PINNED_REV;
use uuid::Uuid;

#[derive(Parser)]
#[command(
    name = "stormdance",
    version,
    about = "Encrypted collaborative notebooks as ordinary Markdown directories",
    long_about = "stormdance links a notebook to an Obsidian-compatible Markdown directory. Humans, agents, editors, and indexers edit files normally; lifecycle commands own identity binding, synchronization, diagnostics, and watching."
)]
struct Cli {
    /// Emit one JSON object and never prompt.
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Configure or inspect a native identity profile (never prints secrets).
    Auth(AuthArgs),
    /// List linked notebook directories supplied on the command line.
    List(ListArgs),
    /// Bind a notebook/XMTP conversation to a Markdown directory.
    Link(LinkArgs),
    /// Reconcile one directory into durable local Yrs state (no XMTP transport).
    Sync(DirectoryArgs),
    /// Continuously reconcile local filesystem changes (no XMTP transport).
    Watch(DirectoryArgs),
    /// Show link, mirror, and pending-change state.
    Status(DirectoryArgs),
    /// Validate profile, inbox assertion, state, paths, and manifest safety.
    Doctor(DirectoryArgs),
    /// Remove the directory binding; Markdown files are retained.
    Unlink(UnlinkArgs),
}

#[derive(Args)]
struct AuthArgs {
    #[command(subcommand)]
    command: AuthCommand,
}

#[derive(Subcommand)]
enum AuthCommand {
    /// Create a local profile descriptor for an existing/recoverable XMTP inbox.
    Init {
        #[arg(long, default_value = "default")]
        profile: String,
        /// Expected XMTP inbox ID. It is a safety assertion, not a credential.
        #[arg(long)]
        inbox_id: Option<String>,
    },
    /// Inspect a profile without exposing identity material.
    Status {
        #[arg(long, default_value = "default")]
        profile: String,
    },
    /// List native profile descriptors.
    List,
}

#[derive(Args)]
struct ListArgs {
    /// Directories to inspect; defaults to the current directory.
    #[arg(value_name = "DIRECTORY")]
    directories: Vec<PathBuf>,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum EnvArg {
    Dev,
    Production,
}

impl From<EnvArg> for Environment {
    fn from(value: EnvArg) -> Self {
        match value {
            EnvArg::Dev => Environment::Dev,
            EnvArg::Production => Environment::Production,
        }
    }
}

#[derive(Args)]
struct LinkArgs {
    /// Notebook ID or conversation ID when they are the same selector.
    selector: String,
    directory: PathBuf,
    #[arg(long)]
    notebook_id: Option<String>,
    #[arg(long)]
    conversation_id: Option<String>,
    #[arg(long, default_value = "Untitled notebook")]
    name: String,
    #[arg(long, default_value = "default")]
    profile: String,
    #[arg(long, value_enum, default_value = "dev")]
    env: EnvArg,
    #[arg(long)]
    expected_inbox_id: Option<String>,
}

#[derive(Args)]
struct DirectoryArgs {
    #[arg(default_value = ".")]
    directory: PathBuf,
}

#[derive(Args)]
struct UnlinkArgs {
    #[arg(default_value = ".")]
    directory: PathBuf,
    /// Also remove local CRDT/manifest state. Markdown notes are never removed.
    #[arg(long)]
    remove_state: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Profile {
    schema: u32,
    name: String,
    profile_id: String,
    inbox_id: Option<String>,
    created_at: u64,
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    if let Err(error) = run(&cli) {
        if cli.json {
            println!(
                "{}",
                serde_json::to_string(&json!({
                    "ok": false,
                    "error": error.to_string(),
                }))
                .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"serialization failed\"}".to_owned())
            );
        } else {
            eprintln!("error: {error:#}");
        }
        std::process::exit(1);
    }
}

fn run(cli: &Cli) -> Result<()> {
    match &cli.command {
        Command::Auth(args) => auth(cli.json, &args.command),
        Command::List(args) => list(cli.json, args),
        Command::Link(args) => link(cli.json, args),
        Command::Sync(args) => sync(cli.json, &args.directory),
        Command::Watch(args) => watch(cli.json, &args.directory),
        Command::Status(args) => status(cli.json, &args.directory),
        Command::Doctor(args) => doctor(cli.json, &args.directory),
        Command::Unlink(args) => unlink(cli.json, args),
    }
}

fn auth(json_output: bool, command: &AuthCommand) -> Result<()> {
    match command {
        AuthCommand::Init { profile, inbox_id } => {
            validate_profile_name(profile)?;
            let directory = profiles_directory()?.join(profile);
            fs::create_dir_all(&directory)
                .with_context(|| format!("create {}", directory.display()))?;
            let destination = directory.join("profile.json");
            if destination.exists() {
                bail!("profile {profile} already exists");
            }
            let descriptor = Profile {
                schema: 1,
                name: profile.clone(),
                profile_id: Uuid::new_v4().to_string(),
                inbox_id: inbox_id.clone(),
                created_at: now_ms(),
            };
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options
                .open(&destination)
                .with_context(|| format!("create {}", destination.display()))?;
            serde_json::to_writer_pretty(&mut file, &descriptor)?;
            use std::io::Write;
            file.write_all(b"\n")?;
            file.sync_all()?;
            emit(
                json_output,
                json!({
                    "ok": true,
                    "profile": descriptor,
                    "credentialsStored": false,
                    "transport": "libxmtp-driver-required"
                }),
                format!(
                    "Created profile {profile}. No private key was stored; attach the pinned libxmtp driver to recover/register this inbox."
                ),
            )
        }
        AuthCommand::Status { profile } => {
            let descriptor = read_profile(profile)?;
            emit(
                json_output,
                json!({"ok": true, "profile": descriptor, "credentialsStored": false}),
                format!(
                    "Profile {}: inbox {} (descriptor only)",
                    descriptor.name,
                    descriptor.inbox_id.as_deref().unwrap_or("not asserted")
                ),
            )
        }
        AuthCommand::List => {
            let mut profiles = Vec::new();
            let root = profiles_directory()?;
            if root.exists() {
                for entry in fs::read_dir(root)? {
                    let entry = entry?;
                    if entry.file_type()?.is_dir() {
                        if let Ok(profile) = read_profile(&entry.file_name().to_string_lossy()) {
                            profiles.push(profile);
                        }
                    }
                }
            }
            profiles.sort_by(|left, right| left.name.cmp(&right.name));
            emit(
                json_output,
                json!({"ok": true, "profiles": profiles}),
                profiles
                    .iter()
                    .map(|profile| profile.name.clone())
                    .collect::<Vec<_>>()
                    .join("\n"),
            )
        }
    }
}

fn link(json_output: bool, args: &LinkArgs) -> Result<()> {
    let profile = read_profile(&args.profile)
        .with_context(|| format!("profile {} must be initialized first", args.profile))?;
    let mirror = Mirror::create(&args.directory)?;
    let expected_inbox_id = args
        .expected_inbox_id
        .clone()
        .or_else(|| profile.inbox_id.clone());
    let config = LinkConfig {
        schema: MIRROR_SCHEMA,
        notebook_id: args
            .notebook_id
            .clone()
            .unwrap_or_else(|| args.selector.clone()),
        conversation_id: args
            .conversation_id
            .clone()
            .unwrap_or_else(|| args.selector.clone()),
        notebook_name: args.name.clone(),
        profile: args.profile.clone(),
        env: args.env.into(),
        expected_inbox_id,
    };
    if let Some(state) = mirror.read_state()? {
        NotebookCrdt::from_update(&config.notebook_id, &state).with_context(|| {
            "existing CRDT state belongs to another notebook or is invalid; use unlink --remove-state before relinking"
        })?;
    }
    mirror.write_link(&config)?;
    let reconcile = mirror.reconcile(now_ms())?;
    emit(
        json_output,
        json!({
            "ok": true,
            "networkSynchronized": false,
            "root": mirror.root(),
            "config": config,
            "notes": reconcile.snapshot.notes.len(),
            "transport": "queued-until-libxmtp-driver"
        }),
        format!(
            "Linked {} to {} locally ({} notes); XMTP transport is not enabled in this native build",
            config.notebook_id,
            mirror.root().display(),
            reconcile.snapshot.notes.len()
        ),
    )
}

fn sync(json_output: bool, directory: &Path) -> Result<()> {
    let mirror = Mirror::open(directory)?;
    let result = mirror.reconcile(now_ms())?;
    emit(
        json_output,
        json!({
            "ok": true,
            "networkSynchronized": false,
            "root": mirror.root(),
            "upserts": result.scan.upserts.len(),
            "deletions": result.scan.deleted_note_ids.len(),
            "written": result.materialized.written_paths,
            "conflicts": result.materialized.conflict_paths,
            "crdtUpdateBytes": result.update.len(),
            "transport": "durable-state-awaiting-libxmtp-driver"
        }),
        format!(
            "Reconciled local state for {}: {} upserts, {} deletions, {} CRDT bytes persisted; no XMTP messages were sent",
            mirror.root().display(),
            result.scan.upserts.len(),
            result.scan.deleted_note_ids.len(),
            result.update.len()
        ),
    )
}

fn watch(json_output: bool, directory: &Path) -> Result<()> {
    let mirror = Mirror::open(directory)?;
    mirror.read_link()?;
    let watcher = mirror.watch()?;
    let initial = mirror.reconcile(now_ms())?;
    emit(
        json_output,
        json!({
            "ok": true,
            "event": "watching-local-only",
            "root": mirror.root(),
            "networkSynchronized": false,
            "initialUpserts": initial.scan.upserts.len(),
            "initialDeletions": initial.scan.deleted_note_ids.len()
        }),
        format!(
            "Watching {} for local reconciliation; XMTP transport is not enabled in this native build",
            mirror.root().display()
        ),
    )?;
    loop {
        match watcher.recv()? {
            MirrorEvent::SelfWrite(_) => continue,
            MirrorEvent::Error(error) => return Err(anyhow!(error)),
            MirrorEvent::External(_) => {
                // Editors frequently emit several save/rename events. Drain a
                // short stability window, but never let continuous writes
                // postpone reconciliation indefinitely.
                let maximum = Instant::now() + Duration::from_secs(1);
                loop {
                    let remaining = maximum.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        break;
                    }
                    match watcher.recv_timeout(remaining.min(Duration::from_millis(250))) {
                        Ok(MirrorEvent::Error(error)) => return Err(anyhow!(error)),
                        Ok(MirrorEvent::External(_) | MirrorEvent::SelfWrite(_)) => continue,
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                            bail!("filesystem watcher disconnected")
                        }
                    }
                }
                let result = mirror.reconcile(now_ms())?;
                emit(
                    json_output,
                    json!({
                        "ok": true,
                        "event": "reconciled",
                        "networkSynchronized": false,
                        "upserts": result.scan.upserts.len(),
                        "deletions": result.scan.deleted_note_ids.len(),
                        "crdtUpdateBytes": result.update.len()
                    }),
                    format!(
                        "Reconciled {} upserts and {} deletions",
                        result.scan.upserts.len(),
                        result.scan.deleted_note_ids.len()
                    ),
                )?;
            }
        }
    }
}

fn status(json_output: bool, directory: &Path) -> Result<()> {
    let mirror = Mirror::open(directory)?;
    let status = mirror.status()?;
    emit(
        json_output,
        json!({"ok": true, "status": status}),
        format!(
            "{}: {} tracked notes, {} pending local changes",
            status.root.display(),
            status.tracked_notes,
            status.pending_local_changes
        ),
    )
}

fn doctor(json_output: bool, directory: &Path) -> Result<()> {
    let mirror = Mirror::open(directory)?;
    let config = mirror.read_link()?;
    let profile = read_profile(&config.profile)?;
    if let (Some(expected), Some(actual)) = (&config.expected_inbox_id, &profile.inbox_id) {
        if expected != actual {
            bail!("expected XMTP inbox {expected}, but profile resolves to {actual}");
        }
    }
    let replica = mirror.load_replica()?;
    let snapshot = replica.snapshot()?;
    let status = mirror.status()?;
    let warnings = if config.expected_inbox_id.is_none() {
        vec!["link has no expected inbox assertion"]
    } else {
        Vec::new()
    };
    emit(
        json_output,
        json!({
            "ok": true,
            "notebookId": snapshot.notebook.id,
            "trackedNotes": status.tracked_notes,
            "pendingLocalChanges": status.pending_local_changes,
            "ignoredPaths": status.ignored_paths,
            "warnings": warnings,
            "libxmtpRevision": LIBXMTP_PINNED_REV,
            "liveTransportReady": false
        }),
        format!(
            "Directory, manifest, and Yrs state are valid. {} warnings. Direct libxmtp driver is not compiled into this binary.",
            warnings.len()
        ),
    )
}

fn unlink(json_output: bool, args: &UnlinkArgs) -> Result<()> {
    let mirror = Mirror::open(&args.directory)?;
    mirror.unlink(args.remove_state)?;
    emit(
        json_output,
        json!({
            "ok": true,
            "root": mirror.root(),
            "stateRemoved": args.remove_state,
            "markdownRemoved": false
        }),
        format!(
            "Unlinked {}; Markdown files were retained",
            mirror.root().display()
        ),
    )
}

fn list(json_output: bool, args: &ListArgs) -> Result<()> {
    let directories = if args.directories.is_empty() {
        vec![PathBuf::from(".")]
    } else {
        args.directories.clone()
    };
    let mut statuses = Vec::new();
    for directory in directories {
        if let Ok(mirror) = Mirror::open(&directory) {
            if let Ok(status) = mirror.status() {
                if status.linked {
                    statuses.push(status);
                }
            }
        }
    }
    emit(
        json_output,
        json!({"ok": true, "links": statuses}),
        statuses
            .iter()
            .map(|status| {
                format!(
                    "{}\t{}",
                    status.notebook_id.as_deref().unwrap_or("unknown"),
                    status.root.display()
                )
            })
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

fn emit(json_output: bool, value: serde_json::Value, human: String) -> Result<()> {
    if json_output {
        println!("{}", serde_json::to_string(&value)?);
    } else {
        println!("{human}");
    }
    Ok(())
}

fn profiles_directory() -> Result<PathBuf> {
    profiles_directory_from(cfg!(windows), |name| env::var_os(name))
}

fn profiles_directory_from(
    windows: bool,
    mut read_environment: impl FnMut(&str) -> Option<std::ffi::OsString>,
) -> Result<PathBuf> {
    if let Some(root) = read_environment("STORMDANCE_HOME") {
        return Ok(PathBuf::from(root).join("profiles"));
    }
    if let Some(root) = read_environment("XDG_DATA_HOME") {
        return Ok(PathBuf::from(root).join("stormdance/profiles"));
    }
    if windows {
        if let Some(root) = read_environment("LOCALAPPDATA").or_else(|| read_environment("APPDATA"))
        {
            return Ok(PathBuf::from(root).join("stormdance/profiles"));
        }
        if let Some(profile) = read_environment("USERPROFILE") {
            return Ok(PathBuf::from(profile).join("AppData/Local/stormdance/profiles"));
        }
    }
    let home = read_environment("HOME").ok_or_else(|| {
        anyhow!("STORMDANCE_HOME, a platform data directory, or HOME is required")
    })?;
    Ok(PathBuf::from(home).join(".local/share/stormdance/profiles"))
}

fn validate_profile_name(profile: &str) -> Result<()> {
    if profile.is_empty()
        || profile.len() > 64
        || !profile
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        bail!("profile names may contain only 1-64 letters, digits, '-' or '_'");
    }
    Ok(())
}

fn read_profile(name: &str) -> Result<Profile> {
    validate_profile_name(name)?;
    let path = profiles_directory()?.join(name).join("profile.json");
    let bytes = fs::read(&path).with_context(|| format!("read {}", path.display()))?;
    let profile: Profile = serde_json::from_slice(&bytes)?;
    if profile.schema != 1 || profile.name != name {
        bail!("invalid profile descriptor for {name}");
    }
    Ok(profile)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(9_007_199_254_740_991) as u64
}

#[allow(dead_code)]
fn profile_fingerprint(profile: &Profile) -> String {
    let mut digest = Sha256::new();
    digest.update(profile.profile_id.as_bytes());
    digest.update(profile.inbox_id.as_deref().unwrap_or_default().as_bytes());
    hex::encode(digest.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::BTreeMap, ffi::OsString};

    #[test]
    fn windows_profiles_use_local_app_data_without_home() {
        let environment = BTreeMap::from([(
            "LOCALAPPDATA".to_owned(),
            OsString::from(r"C:\Users\agent\AppData\Local"),
        )]);
        let directory = profiles_directory_from(true, |name| environment.get(name).cloned())
            .expect("Windows profile directory");
        assert_eq!(
            directory,
            PathBuf::from(r"C:\Users\agent\AppData\Local").join("stormdance/profiles")
        );
    }

    #[test]
    fn explicit_stormdance_home_has_priority() {
        let environment = BTreeMap::from([
            ("STORMDANCE_HOME".to_owned(), OsString::from("/storm")),
            ("XDG_DATA_HOME".to_owned(), OsString::from("/xdg")),
        ]);
        let directory = profiles_directory_from(false, |name| environment.get(name).cloned())
            .expect("explicit profile directory");
        assert_eq!(directory, PathBuf::from("/storm/profiles"));
    }
}
