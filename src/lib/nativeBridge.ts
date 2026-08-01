export const NATIVE_SYNC_STATUS_EVENT = 'stormdance://sync-status';
export const NATIVE_CRDT_UPDATE_EVENT = 'stormdance://native-update';

export type RuntimeKind = 'web' | 'desktop';

export interface NativeRuntimeStatus {
  runtime: RuntimeKind;
  platform: string;
  version: string;
  watchedDirectories: string[];
}

export interface NativeLinkRecord {
  directory: string;
  notebookId?: string;
  conversationId?: string;
  profile?: string;
  env?: 'dev' | 'production';
  expectedInboxId?: string;
}

export interface NativeSyncStatus {
  directory: string;
  state: 'idle' | 'starting' | 'watching' | 'stopped' | 'error';
  detail?: string;
  updatedAt: number;
}

export interface NativeCrdtUpdate {
  directory: string;
  notebookId: string;
  conversationId: string;
  env: 'dev' | 'production';
  updateBase64: string;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export const isTauriRuntime = (): boolean =>
  typeof window !== 'undefined' && window.__TAURI_INTERNALS__ !== undefined;

const webStatus = (): NativeRuntimeStatus => ({
  runtime: 'web',
  platform: typeof navigator === 'undefined' ? 'unknown' : navigator.platform || 'browser',
  version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'unknown',
  watchedDirectories: [],
});

/**
 * The hosted web build never imports or invokes native APIs. Tauri exposes the
 * same React application and opts into the native bridge at runtime.
 */
export async function getNativeRuntimeStatus(): Promise<NativeRuntimeStatus> {
  if (!isTauriRuntime()) return webStatus();
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<NativeRuntimeStatus>('native_status');
}

export async function listNativeLinks(): Promise<NativeLinkRecord[]> {
  if (!isTauriRuntime()) return [];
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<NativeLinkRecord[]>('native_list_links');
}

export async function pickNativeDirectory(): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string | null>('native_pick_directory');
}

export async function startNativeWatch(directory: string): Promise<NativeSyncStatus> {
  if (!isTauriRuntime()) throw new Error('Native directory watching requires storm.dance desktop.');
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<NativeSyncStatus>('native_start_watch', { request: { directory } });
}

export async function stopNativeWatch(directory: string): Promise<NativeSyncStatus> {
  if (!isTauriRuntime()) throw new Error('Native directory watching requires storm.dance desktop.');
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<NativeSyncStatus>('native_stop_watch', { request: { directory } });
}

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const chunkBytes = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkBytes));
  }
  return btoa(binary);
};

export const decodeNativeCrdtUpdate = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

/** Mirror a complete browser Yjs state into every watched native vault. */
export async function applyNativeNotebookState(
  notebookId: string,
  conversationId: string,
  env: 'dev' | 'production',
  state: Uint8Array,
): Promise<NativeSyncStatus[]> {
  if (!isTauriRuntime()) return [];
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<NativeSyncStatus[]>('native_apply_state', {
    request: {
      notebookId,
      conversationId,
      env,
      stateBase64: bytesToBase64(state),
    },
  });
}

export async function listenForNativeSyncStatus(
  handler: (status: NativeSyncStatus) => void,
): Promise<() => void> {
  if (!isTauriRuntime()) return () => undefined;
  const { listen } = await import('@tauri-apps/api/event');
  return listen<NativeSyncStatus>(NATIVE_SYNC_STATUS_EVENT, ({ payload }) => handler(payload));
}

export async function listenForNativeCrdtUpdates(
  handler: (update: NativeCrdtUpdate) => void,
): Promise<() => void> {
  if (!isTauriRuntime()) return () => undefined;
  const { listen } = await import('@tauri-apps/api/event');
  return listen<NativeCrdtUpdate>(NATIVE_CRDT_UPDATE_EVENT, ({ payload }) => handler(payload));
}
