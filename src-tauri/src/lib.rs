//! Tauri boundary for the storm.dance native core.
//!
//! Keep this crate deliberately thin: the web build never imports it, while
//! the CLI, daemon, and desktop app share the runtime-independent Rust crates.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, RecvTimeoutError, Sender, TryRecvError},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};
use storm_storage::{Environment, Mirror, MirrorEvent};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    App, AppHandle, Emitter, Manager, State,
};
use tauri_plugin_dialog::DialogExt;

pub const NATIVE_SYNC_STATUS_EVENT: &str = "stormdance://sync-status";
pub const NATIVE_CRDT_UPDATE_EVENT: &str = "stormdance://native-update";
const MAX_NATIVE_STATE_BYTES: usize = 64 * 1024 * 1024;
const MAX_NATIVE_STATE_BASE64_BYTES: usize = MAX_NATIVE_STATE_BYTES.div_ceil(3) * 4;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRuntimeStatus {
    runtime: &'static str,
    platform: String,
    version: &'static str,
    watched_directories: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeLinkRecord {
    directory: String,
    notebook_id: Option<String>,
    conversation_id: Option<String>,
    profile: Option<String>,
    env: Option<LinkEnvironment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expected_inbox_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NativeSyncState {
    Idle,
    Starting,
    Watching,
    Stopped,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSyncStatus {
    directory: String,
    state: NativeSyncState,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    updated_at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeWatchRequest {
    directory: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeApplyStateRequest {
    notebook_id: String,
    conversation_id: String,
    env: LinkEnvironment,
    state_base64: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCrdtUpdate {
    directory: String,
    notebook_id: String,
    conversation_id: String,
    env: LinkEnvironment,
    update_base64: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkEnvironment {
    Dev,
    Production,
}

struct WatchRegistration {
    stop: Sender<()>,
    thread: Option<JoinHandle<()>>,
    link: NativeLinkRecord,
    mirror: Mirror,
    sync_lock: Arc<Mutex<()>>,
    active: Arc<AtomicBool>,
}

enum WatchEntry {
    Starting,
    Active(Box<WatchRegistration>),
    Stopping,
}

#[derive(Clone, Default)]
struct DesktopState {
    watches: Arc<Mutex<BTreeMap<PathBuf, WatchEntry>>>,
}

fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn status(
    directory: impl Into<String>,
    state: NativeSyncState,
    detail: impl Into<Option<String>>,
) -> NativeSyncStatus {
    NativeSyncStatus {
        directory: directory.into(),
        state,
        detail: detail.into(),
        updated_at: unix_millis(),
    }
}

fn directory_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn open_mirror(directory: &str) -> Result<Mirror, String> {
    if directory.trim().is_empty() {
        return Err("A linked directory is required.".to_owned());
    }
    Mirror::open(directory).map_err(|error| format!("Cannot open linked directory: {error}"))
}

fn read_link(mirror: &Mirror) -> Result<NativeLinkRecord, String> {
    let config = mirror
        .read_link()
        .map_err(|error| format!("Cannot read linked notebook configuration: {error}"))?;
    Ok(NativeLinkRecord {
        directory: directory_string(mirror.root()),
        notebook_id: Some(config.notebook_id),
        conversation_id: Some(config.conversation_id),
        profile: Some(config.profile),
        env: Some(match config.env {
            Environment::Dev => LinkEnvironment::Dev,
            Environment::Production => LinkEnvironment::Production,
        }),
        expected_inbox_id: config.expected_inbox_id,
    })
}

fn reconcile_mirror(
    app: &AppHandle,
    mirror: &Mirror,
    notebook_id: &str,
    conversation_id: &str,
    env: LinkEnvironment,
    emit_unchanged_state: bool,
) -> Result<String, String> {
    let result = mirror
        .reconcile(unix_millis())
        .map_err(|error| format!("Native Markdown reconciliation failed: {error}"))?;
    if emit_unchanged_state || result.update.as_slice() != [0, 0] {
        emit_native_state(app, mirror, notebook_id, conversation_id, env)?;
    }
    Ok(format!(
        "Reconciled {} local edit(s), {} deletion(s), {} write(s), and {} conflict copy/copies.",
        result.scan.upserts.len(),
        result.scan.deleted_note_ids.len(),
        result.materialized.written_paths.len(),
        result.materialized.conflict_paths.len(),
    ))
}

fn emit_native_state(
    app: &AppHandle,
    mirror: &Mirror,
    notebook_id: &str,
    conversation_id: &str,
    env: LinkEnvironment,
) -> Result<(), String> {
    let full_state = mirror
        .read_state()
        .map_err(|error| format!("Cannot read reconciled native CRDT state: {error}"))?
        .ok_or_else(|| "The reconciled native CRDT state is unavailable.".to_owned())?;
    let update = NativeCrdtUpdate {
        directory: directory_string(mirror.root()),
        notebook_id: notebook_id.to_owned(),
        conversation_id: conversation_id.to_owned(),
        env,
        update_base64: BASE64.encode(full_state),
    };
    app.emit(NATIVE_CRDT_UPDATE_EVENT, &update)
        .map_err(|error| format!("Cannot emit native CRDT update: {error}"))
}

fn decode_crdt_state(notebook_id: &str, state_base64: &str) -> Result<Vec<u8>, String> {
    if notebook_id.trim().is_empty() {
        return Err("A notebook ID is required.".to_owned());
    }
    if state_base64.len() > MAX_NATIVE_STATE_BASE64_BYTES {
        return Err("The native CRDT state exceeds the size limit.".to_owned());
    }
    let update = BASE64
        .decode(state_base64)
        .map_err(|error| format!("Invalid base64 CRDT state: {error}"))?;
    if update.len() > MAX_NATIVE_STATE_BYTES {
        return Err("The native CRDT state exceeds the size limit.".to_owned());
    }
    storm_core::NotebookCrdt::from_update(notebook_id, &update)
        .map_err(|error| format!("Invalid native CRDT state: {error}"))?;
    Ok(update)
}

fn emit_status(app: &AppHandle, sync_status: &NativeSyncStatus) {
    if let Err(error) = app.emit(NATIVE_SYNC_STATUS_EVENT, sync_status) {
        eprintln!("failed to emit native sync status: {error}");
    }
}

fn stop_registration(mut registration: WatchRegistration) -> Result<(), String> {
    registration.active.store(false, Ordering::Release);
    let _ignored = registration.stop.send(());
    if let Some(thread) = registration.thread.take() {
        thread
            .join()
            .map_err(|_| "Native filesystem watcher panicked while stopping.".to_owned())?;
    }
    let _guard = registration
        .sync_lock
        .lock()
        .map_err(|_| "Native mirror state is unavailable.".to_owned())?;
    Ok(())
}

fn clear_starting_registration(state: &DesktopState, directory: &Path) {
    let Ok(mut watches) = state.watches.lock() else {
        return;
    };
    if matches!(watches.get(directory), Some(WatchEntry::Starting)) {
        watches.remove(directory);
    }
}

fn remove_active_registration(state: &DesktopState, directory: &Path, active: &Arc<AtomicBool>) {
    let Ok(mut watches) = state.watches.lock() else {
        return;
    };
    let should_remove = matches!(
        watches.get(directory),
        Some(WatchEntry::Active(registration)) if Arc::ptr_eq(&registration.active, active)
    );
    if should_remove {
        watches.remove(directory);
    }
}

#[tauri::command]
fn native_status(state: State<'_, DesktopState>) -> Result<NativeRuntimeStatus, String> {
    let watches = state
        .watches
        .lock()
        .map_err(|_| "Native watcher state is unavailable.".to_owned())?;
    Ok(NativeRuntimeStatus {
        runtime: "desktop",
        platform: std::env::consts::OS.to_owned(),
        version: env!("CARGO_PKG_VERSION"),
        watched_directories: watches
            .iter()
            .filter(|(_, entry)| matches!(entry, WatchEntry::Active(_)))
            .map(|(path, _)| directory_string(path))
            .collect(),
    })
}

#[tauri::command]
fn native_list_links(state: State<'_, DesktopState>) -> Result<Vec<NativeLinkRecord>, String> {
    let watches = state
        .watches
        .lock()
        .map_err(|_| "Native watcher state is unavailable.".to_owned())?;
    Ok(watches
        .values()
        .filter_map(|entry| match entry {
            WatchEntry::Active(registration) => Some(registration.link.clone()),
            WatchEntry::Starting | WatchEntry::Stopping => None,
        })
        .collect())
}

#[tauri::command]
async fn native_pick_directory(app: AppHandle) -> Result<Option<String>, String> {
    app.dialog()
        .file()
        .set_title("Choose a linked storm.dance vault")
        .blocking_pick_folder()
        .map(|path| {
            path.into_path()
                .map(|path| directory_string(&path))
                .map_err(|error| format!("The selected directory path is unavailable: {error}"))
        })
        .transpose()
}

fn native_apply_state_blocking(
    app: &AppHandle,
    state: &DesktopState,
    request: NativeApplyStateRequest,
) -> Result<Vec<NativeSyncStatus>, String> {
    if request.notebook_id.trim().is_empty() {
        return Err("A notebook ID is required.".to_owned());
    }
    if request.conversation_id.trim().is_empty() {
        return Err("An XMTP conversation ID is required.".to_owned());
    }
    let update = decode_crdt_state(&request.notebook_id, &request.state_base64)?;
    let targets: Vec<(Mirror, Arc<Mutex<()>>, Arc<AtomicBool>)> = {
        let watches = state
            .watches
            .lock()
            .map_err(|_| "Native watcher state is unavailable.".to_owned())?;
        let mut targets = Vec::new();
        for entry in watches.values() {
            let WatchEntry::Active(registration) = entry else {
                continue;
            };
            if registration.link.notebook_id.as_deref() != Some(request.notebook_id.as_str())
                || registration.link.conversation_id.as_deref()
                    != Some(request.conversation_id.as_str())
                || registration.link.env != Some(request.env)
            {
                continue;
            }
            targets.push((
                registration.mirror.clone(),
                Arc::clone(&registration.sync_lock),
                Arc::clone(&registration.active),
            ));
        }
        targets
    };
    if targets.is_empty() {
        return Ok(Vec::new());
    }

    let mut statuses = Vec::with_capacity(targets.len());
    let mut first_error = None;
    for (mirror, sync_lock, active) in targets {
        let directory = directory_string(mirror.root());
        let applied = (|| -> Result<Option<NativeSyncStatus>, String> {
            let _guard = sync_lock
                .lock()
                .map_err(|_| "Native mirror state is unavailable.".to_owned())?;
            if !active.load(Ordering::Acquire) {
                return Ok(None);
            }
            let local = mirror
                .reconcile(unix_millis())
                .map_err(|error| format!("Cannot reconcile pending Markdown edits: {error}"))?;
            if !active.load(Ordering::Acquire) {
                return Ok(None);
            }
            let replica = mirror
                .load_replica()
                .map_err(|error| format!("Cannot load native CRDT state: {error}"))?;
            replica
                .apply_update_v1(&update)
                .map_err(|error| format!("Cannot merge native CRDT state: {error}"))?;
            if !active.load(Ordering::Acquire) {
                return Ok(None);
            }
            let materialized = mirror
                .persist_and_materialize(&replica, unix_millis())
                .map_err(|error| format!("Cannot materialize native CRDT state: {error}"))?;
            if !active.load(Ordering::Acquire) {
                return Ok(None);
            }
            // Echo the complete merged state back through the typed event. This
            // acknowledges browser state and retries native state that arrived
            // while the webview was busy or not yet bound.
            emit_native_state(
                app,
                &mirror,
                &request.notebook_id,
                &request.conversation_id,
                request.env,
            )?;
            Ok(Some(status(
                directory.clone(),
                NativeSyncState::Watching,
                Some(format!(
                    "Merged {} pending local edit(s) and applied remote state with {} write(s), {} removal(s), and {} conflict copy/copies.",
                    local.scan.upserts.len() + local.scan.deleted_note_ids.len(),
                    materialized.written_paths.len(),
                    materialized.removed_paths.len(),
                    materialized.conflict_paths.len(),
                )),
            )))
        })();
        match applied {
            Ok(Some(sync_status)) => {
                emit_status(app, &sync_status);
                statuses.push(sync_status);
            }
            Ok(None) => {}
            Err(error) => {
                let sync_status = status(directory, NativeSyncState::Error, Some(error.clone()));
                emit_status(app, &sync_status);
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
    }
    if let Some(error) = first_error {
        return Err(error);
    }
    Ok(statuses)
}

#[tauri::command]
async fn native_apply_state(
    app: AppHandle,
    state: State<'_, DesktopState>,
    request: NativeApplyStateRequest,
) -> Result<Vec<NativeSyncStatus>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || native_apply_state_blocking(&app, &state, request))
        .await
        .map_err(|error| format!("Native state worker failed: {error}"))?
}

fn native_start_watch_blocking(
    app: &AppHandle,
    state: &DesktopState,
    request: NativeWatchRequest,
) -> Result<NativeSyncStatus, String> {
    let mirror = open_mirror(&request.directory)?;
    let directory = mirror.root().to_path_buf();
    let directory_display = directory_string(mirror.root());
    let link = read_link(&mirror)?;
    let notebook_id = link
        .notebook_id
        .clone()
        .ok_or_else(|| "The linked notebook ID is unavailable.".to_owned())?;
    let environment = link
        .env
        .ok_or_else(|| "The linked XMTP environment is unavailable.".to_owned())?;
    let conversation_id = link
        .conversation_id
        .clone()
        .ok_or_else(|| "The linked XMTP conversation ID is unavailable.".to_owned())?;
    mirror
        .load_replica()
        .map_err(|error| format!("Cannot load native CRDT state: {error}"))?;

    {
        use std::collections::btree_map::Entry;
        let mut watches = state
            .watches
            .lock()
            .map_err(|_| "Native watcher state is unavailable.".to_owned())?;
        match watches.entry(directory.clone()) {
            Entry::Vacant(entry) => {
                entry.insert(WatchEntry::Starting);
            }
            Entry::Occupied(entry) => {
                return match entry.get() {
                    WatchEntry::Active(_) => Ok(status(
                        directory_display,
                        NativeSyncState::Watching,
                        Some("The linked directory is already being watched.".to_owned()),
                    )),
                    WatchEntry::Starting => {
                        Err("The linked directory watcher is already starting.".to_owned())
                    }
                    WatchEntry::Stopping => {
                        Err("The linked directory watcher is still stopping.".to_owned())
                    }
                };
            }
        }
    }

    let starting = status(
        directory_display.clone(),
        NativeSyncState::Starting,
        Some("Validating the linked Markdown directory.".to_owned()),
    );
    emit_status(app, &starting);

    let mirror_watcher = match mirror.watch() {
        Ok(watcher) => watcher,
        Err(error) => {
            clear_starting_registration(state, &directory);
            return Err(format!("Cannot watch linked directory: {error}"));
        }
    };
    let (stop, stop_receiver) = mpsc::channel();
    let callback_app = app.clone();
    let callback_directory = directory_display.clone();
    let watch_mirror = mirror.clone();
    let watch_notebook_id = notebook_id.clone();
    let watch_conversation_id = conversation_id.clone();
    let watch_environment = environment;
    let sync_lock = Arc::new(Mutex::new(()));
    let watch_sync_lock = Arc::clone(&sync_lock);
    let active = Arc::new(AtomicBool::new(true));
    let watch_active = Arc::clone(&active);
    let watch_state = state.clone();
    let watch_directory = directory.clone();
    let thread = thread::Builder::new()
        .name("stormdance-vault-watch".to_owned())
        .spawn(move || {
            loop {
                match stop_receiver.try_recv() {
                    Ok(()) | Err(TryRecvError::Disconnected) => break,
                    Err(TryRecvError::Empty) => {}
                }
                if !watch_active.load(Ordering::Acquire) {
                    break;
                }
                match mirror_watcher.recv_timeout(Duration::from_millis(250)) {
                    Ok(MirrorEvent::External(paths)) if !paths.is_empty() => {
                        let reconciled = match watch_sync_lock.lock() {
                            Ok(_guard) if watch_active.load(Ordering::Acquire) => reconcile_mirror(
                                &callback_app,
                                &watch_mirror,
                                &watch_notebook_id,
                                &watch_conversation_id,
                                watch_environment,
                                false,
                            ),
                            Ok(_) => break,
                            Err(_) => {
                                emit_status(
                                    &callback_app,
                                    &status(
                                        callback_directory.clone(),
                                        NativeSyncState::Error,
                                        Some("Native mirror state is unavailable.".to_owned()),
                                    ),
                                );
                                break;
                            }
                        };
                        let sync_status = match reconciled {
                            Ok(detail) => status(
                                callback_directory.clone(),
                                NativeSyncState::Watching,
                                Some(detail),
                            ),
                            Err(detail) => status(
                                callback_directory.clone(),
                                NativeSyncState::Error,
                                Some(detail),
                            ),
                        };
                        emit_status(&callback_app, &sync_status);
                    }
                    Ok(MirrorEvent::External(_) | MirrorEvent::SelfWrite(_)) => {}
                    Ok(MirrorEvent::Error(detail)) => emit_status(
                        &callback_app,
                        &status(
                            callback_directory.clone(),
                            NativeSyncState::Error,
                            Some(format!("Filesystem watcher error: {detail}")),
                        ),
                    ),
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => {
                        emit_status(
                            &callback_app,
                            &status(
                                callback_directory.clone(),
                                NativeSyncState::Error,
                                Some("Filesystem watcher stopped unexpectedly.".to_owned()),
                            ),
                        );
                        break;
                    }
                }
            }
            watch_active.store(false, Ordering::Release);
            remove_active_registration(&watch_state, &watch_directory, &watch_active);
        })
        .map_err(|error| {
            clear_starting_registration(state, &directory);
            format!("Cannot start filesystem watcher thread: {error}")
        })?;

    let registration = WatchRegistration {
        stop,
        thread: Some(thread),
        link,
        mirror: mirror.clone(),
        sync_lock: Arc::clone(&sync_lock),
        active: Arc::clone(&active),
    };
    let initial_detail = match sync_lock.lock() {
        Ok(_guard) => reconcile_mirror(
            app,
            &mirror,
            &notebook_id,
            &conversation_id,
            environment,
            true,
        ),
        Err(_) => Err("Native mirror state is unavailable.".to_owned()),
    };
    let initial_detail = match initial_detail {
        Ok(detail) => detail,
        Err(error) => {
            clear_starting_registration(state, &directory);
            let _ignored = stop_registration(registration);
            return Err(error);
        }
    };

    if !active.load(Ordering::Acquire)
        || registration
            .thread
            .as_ref()
            .is_some_and(JoinHandle::is_finished)
    {
        clear_starting_registration(state, &directory);
        let _ignored = stop_registration(registration);
        return Err("Filesystem watcher stopped while it was starting.".to_owned());
    }

    let mut registration = Some(registration);
    let inserted = match state.watches.lock() {
        Ok(mut watches) if matches!(watches.get(&directory), Some(WatchEntry::Starting)) => {
            if let Some(registration) = registration.take() {
                watches.insert(
                    directory.clone(),
                    WatchEntry::Active(Box::new(registration)),
                );
                true
            } else {
                false
            }
        }
        Ok(_) => false,
        Err(_) => {
            if let Some(registration) = registration.take() {
                let _ignored = stop_registration(registration);
            }
            return Err("Native watcher state is unavailable.".to_owned());
        }
    };
    if !inserted {
        clear_starting_registration(state, &directory);
        if let Some(registration) = registration {
            let _ignored = stop_registration(registration);
        }
        return Err("Native watcher lifecycle changed while it was starting.".to_owned());
    }

    let watching = status(
        directory_display,
        NativeSyncState::Watching,
        Some(initial_detail),
    );
    emit_status(app, &watching);
    Ok(watching)
}

#[tauri::command]
async fn native_start_watch(
    app: AppHandle,
    state: State<'_, DesktopState>,
    request: NativeWatchRequest,
) -> Result<NativeSyncStatus, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || native_start_watch_blocking(&app, &state, request))
        .await
        .map_err(|error| format!("Native watcher start worker failed: {error}"))?
}

fn native_stop_watch_blocking(
    app: &AppHandle,
    state: &DesktopState,
    request: NativeWatchRequest,
) -> Result<NativeSyncStatus, String> {
    if request.directory.trim().is_empty() {
        return Err("A linked directory is required.".to_owned());
    }
    let (directory, directory_display) = match open_mirror(&request.directory) {
        Ok(mirror) => (mirror.root().to_path_buf(), directory_string(mirror.root())),
        Err(open_error) => {
            // A watched directory can be renamed, unmounted, or deleted. Its
            // worker must still be stoppable by the canonical string returned
            // from native_status instead of becoming an unreachable registry
            // entry that survives until process exit.
            let watches = state
                .watches
                .lock()
                .map_err(|_| "Native watcher state is unavailable.".to_owned())?;
            let Some(path) = watches
                .keys()
                .find(|path| directory_string(path) == request.directory)
                .cloned()
            else {
                return Err(open_error);
            };
            (path, request.directory.clone())
        }
    };
    let registration = {
        let mut watches = state
            .watches
            .lock()
            .map_err(|_| "Native watcher state is unavailable.".to_owned())?;
        match watches.remove(&directory) {
            Some(WatchEntry::Active(registration)) => {
                watches.insert(directory.clone(), WatchEntry::Stopping);
                Some(*registration)
            }
            Some(WatchEntry::Starting) => {
                watches.insert(directory, WatchEntry::Starting);
                return Err("The linked directory watcher is still starting.".to_owned());
            }
            Some(WatchEntry::Stopping) => {
                watches.insert(directory, WatchEntry::Stopping);
                return Err("The linked directory watcher is already stopping.".to_owned());
            }
            None => None,
        }
    };
    let removed = registration.is_some();
    let stop_result = registration.map(stop_registration).transpose();
    if removed {
        let mut watches = state
            .watches
            .lock()
            .map_err(|_| "Native watcher state is unavailable.".to_owned())?;
        if matches!(watches.get(&directory), Some(WatchEntry::Stopping)) {
            watches.remove(&directory);
        }
    }
    stop_result?;
    let stopped = status(
        directory_display,
        NativeSyncState::Stopped,
        Some(if removed {
            "Stopped watching the linked Markdown directory.".to_owned()
        } else {
            "The linked directory was not being watched.".to_owned()
        }),
    );
    emit_status(app, &stopped);
    Ok(stopped)
}

#[tauri::command]
async fn native_stop_watch(
    app: AppHandle,
    state: State<'_, DesktopState>,
    request: NativeWatchRequest,
) -> Result<NativeSyncStatus, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || native_stop_watch_blocking(&app, &state, request))
        .await
        .map_err(|error| format!("Native watcher stop worker failed: {error}"))?
}

fn install_tray(app: &mut App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show storm.dance", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut tray = TrayIconBuilder::new()
        .tooltip("storm.dance")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    if let Err(error) = window.show() {
                        eprintln!("failed to show main window: {error}");
                    }
                    if let Err(error) = window.set_focus() {
                        eprintln!("failed to focus main window: {error}");
                    }
                }
            }
            "quit" => {
                let registrations = app
                    .state::<DesktopState>()
                    .watches
                    .lock()
                    .map(|mut watches| {
                        std::mem::take(&mut *watches)
                            .into_values()
                            .filter_map(|entry| match entry {
                                WatchEntry::Active(registration) => Some(*registration),
                                WatchEntry::Starting | WatchEntry::Stopping => None,
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                for registration in registrations {
                    if let Err(error) = stop_registration(registration) {
                        eprintln!("failed to stop native watcher during quit: {error}");
                    }
                }
                app.exit(0);
            }
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

pub fn run() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(DesktopState::default())
        .setup(|app| {
            install_tray(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Err(error) = window.hide() {
                    eprintln!("failed to hide main window: {error}");
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            native_status,
            native_list_links,
            native_pick_directory,
            native_apply_state,
            native_start_watch,
            native_stop_watch
        ])
        .run(tauri::generate_context!());
    if let Err(error) = result {
        eprintln!("storm.dance desktop failed: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn link_config_is_projected_for_the_web_bridge() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let state = temporary.path().join(".stormdance");
        fs::create_dir(&state).expect("state directory");
        fs::write(
            state.join("config.json"),
            r#"{"schema":2,"notebookId":"notes","conversationId":"group","notebookName":"Notes","profile":"default","env":"dev","expectedInboxId":"inbox"}"#,
        )
        .expect("link config");

        let mirror = Mirror::open(temporary.path()).expect("mirror");
        let link = read_link(&mirror).expect("valid link");
        assert_eq!(link.notebook_id.as_deref(), Some("notes"));
        assert_eq!(link.conversation_id.as_deref(), Some("group"));
        assert_eq!(link.profile.as_deref(), Some("default"));
        assert_eq!(link.env, Some(LinkEnvironment::Dev));
        assert_eq!(link.expected_inbox_id.as_deref(), Some("inbox"));
    }

    #[test]
    fn link_config_rejects_unsupported_schema() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let state = temporary.path().join(".stormdance");
        fs::create_dir(&state).expect("state directory");
        fs::write(
            state.join("config.json"),
            r#"{"schema":99,"notebookId":"notes","conversationId":"group","notebookName":"Notes","profile":"default","env":"dev"}"#,
        )
        .expect("link config");

        let mirror = Mirror::open(temporary.path()).expect("mirror");
        let error = read_link(&mirror).expect_err("unsupported schema must fail");
        assert!(error.contains("unsupported schema"));
    }

    #[test]
    fn status_contract_uses_camel_case_and_epoch_milliseconds() {
        let value = serde_json::to_value(status("/notes", NativeSyncState::Watching, None))
            .expect("serialize status");
        assert_eq!(value["directory"], "/notes");
        assert_eq!(value["state"], "watching");
        assert!(value.get("updatedAt").is_some());
        assert!(value.get("updated_at").is_none());
    }

    #[test]
    fn native_update_contract_includes_the_xmtp_environment() {
        let value = serde_json::to_value(NativeCrdtUpdate {
            directory: "/notes".to_owned(),
            notebook_id: "notebook".to_owned(),
            conversation_id: "conversation".to_owned(),
            env: LinkEnvironment::Production,
            update_base64: "AAA=".to_owned(),
        })
        .expect("serialize native update");
        assert_eq!(value["notebookId"], "notebook");
        assert_eq!(value["conversationId"], "conversation");
        assert_eq!(value["env"], "production");
        assert_eq!(value["updateBase64"], "AAA=");
    }

    #[test]
    fn apply_state_request_contract_uses_camel_case_and_rejects_unknown_fields() {
        let request: NativeApplyStateRequest = serde_json::from_value(serde_json::json!({
            "notebookId": "notebook",
            "conversationId": "conversation",
            "env": "dev",
            "stateBase64": "AAA="
        }))
        .expect("valid native apply request");
        assert_eq!(request.notebook_id, "notebook");
        assert_eq!(request.conversation_id, "conversation");
        assert_eq!(request.env, LinkEnvironment::Dev);

        assert!(
            serde_json::from_value::<NativeApplyStateRequest>(serde_json::json!({
                "notebookId": "notebook",
                "conversationId": "conversation",
                "env": "dev",
                "stateBase64": "AAA=",
                "unknown": true
            }))
            .is_err()
        );
    }

    #[test]
    fn native_state_validation_rejects_malformed_or_mismatched_updates() {
        assert!(decode_crdt_state("notebook", "not base64").is_err());

        let replica = storm_core::NotebookCrdt::new("notebook").expect("replica");
        replica
            .seed(
                &storm_core::NotebookSeed {
                    id: "notebook".to_owned(),
                    name: "Notes".to_owned(),
                    created_at: 1,
                    updated_at: 1,
                },
                &[],
            )
            .expect("seed replica");
        let encoded = BASE64.encode(replica.encode_state_as_update_v1());
        assert!(decode_crdt_state("notebook", &encoded).is_ok());
        assert!(decode_crdt_state("other-notebook", &encoded).is_err());
    }
}
