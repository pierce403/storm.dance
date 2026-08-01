import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauriMocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: tauriMocks.listen }));

import {
  NATIVE_CRDT_UPDATE_EVENT,
  NATIVE_SYNC_STATUS_EVENT,
  getNativeRuntimeStatus,
  isTauriRuntime,
  listNativeLinks,
  applyNativeNotebookState,
  listenForNativeCrdtUpdates,
  listenForNativeSyncStatus,
  pickNativeDirectory,
  startNativeWatch,
  stopNativeWatch,
  type NativeCrdtUpdate,
  type NativeSyncStatus,
} from './nativeBridge';

describe('native bridge web fallback', () => {
  beforeEach(() => {
    tauriMocks.invoke.mockReset();
    tauriMocks.listen.mockReset();
    Object.defineProperty(globalThis, 'window', {
      value: {},
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window');
  });

  it('keeps the hosted web client independent from Tauri', async () => {
    delete window.__TAURI_INTERNALS__;

    expect(isTauriRuntime()).toBe(false);
    await expect(getNativeRuntimeStatus()).resolves.toMatchObject({
      runtime: 'web',
      version: 'unknown',
      watchedDirectories: [],
    });
    await expect(listNativeLinks()).resolves.toEqual([]);
    await expect(pickNativeDirectory()).resolves.toBeNull();
    await expect(applyNativeNotebookState('notebook', 'conversation', 'dev', new Uint8Array([0, 0])))
      .resolves.toEqual([]);
    expect(tauriMocks.invoke).not.toHaveBeenCalled();
    expect(tauriMocks.listen).not.toHaveBeenCalled();

    const unsubscribe = await listenForNativeSyncStatus(() => {
      throw new Error('The web fallback must not subscribe to native events.');
    });
    expect(unsubscribe()).toBeUndefined();

    const unsubscribeUpdates = await listenForNativeCrdtUpdates(() => {
      throw new Error('The web fallback must not subscribe to native CRDT updates.');
    });
    expect(unsubscribeUpdates()).toBeUndefined();
  });

  it('detects a Tauri runtime without probing native APIs', () => {
    window.__TAURI_INTERNALS__ = {};
    expect(isTauriRuntime()).toBe(true);
  });

  it('uses the exact typed Tauri command argument contracts', async () => {
    window.__TAURI_INTERNALS__ = {};
    tauriMocks.invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'native_status':
          return {
            runtime: 'desktop',
            platform: 'linux',
            version: '0.2.0',
            watchedDirectories: ['/vault'],
          };
        case 'native_list_links':
          return [{ directory: '/vault', notebookId: 'notebook' }];
        case 'native_pick_directory':
          return '/vault';
        case 'native_start_watch':
        case 'native_stop_watch':
          return { directory: '/vault', state: 'watching', updatedAt: 1 };
        case 'native_apply_state':
          return [];
        default:
          throw new Error(`Unexpected command ${command}`);
      }
    });

    await expect(getNativeRuntimeStatus()).resolves.toMatchObject({ runtime: 'desktop' });
    await expect(listNativeLinks()).resolves.toHaveLength(1);
    await expect(pickNativeDirectory()).resolves.toBe('/vault');
    await startNativeWatch('/vault');
    await stopNativeWatch('/vault');
    await applyNativeNotebookState(
      'notebook',
      'conversation',
      'production',
      new Uint8Array([0, 255, 1]),
    );

    expect(tauriMocks.invoke.mock.calls).toEqual([
      ['native_status'],
      ['native_list_links'],
      ['native_pick_directory'],
      ['native_start_watch', { request: { directory: '/vault' } }],
      ['native_stop_watch', { request: { directory: '/vault' } }],
      ['native_apply_state', {
        request: {
          notebookId: 'notebook',
          conversationId: 'conversation',
          env: 'production',
          stateBase64: 'AP8B',
        },
      }],
    ]);
  });

  it('subscribes and unsubscribes using the exact native event contracts', async () => {
    window.__TAURI_INTERNALS__ = {};
    const unlistenStatus = vi.fn();
    const unlistenUpdate = vi.fn();
    const listeners = new Map<string, (event: { payload: unknown }) => void>();
    tauriMocks.listen.mockImplementation(async (
      event: string,
      handler: (event: { payload: unknown }) => void,
    ) => {
      listeners.set(event, handler);
      return event === NATIVE_SYNC_STATUS_EVENT ? unlistenStatus : unlistenUpdate;
    });
    const statuses: NativeSyncStatus[] = [];
    const updates: NativeCrdtUpdate[] = [];

    const stopStatus = await listenForNativeSyncStatus((status) => statuses.push(status));
    const stopUpdate = await listenForNativeCrdtUpdates((update) => updates.push(update));
    const nativeStatus: NativeSyncStatus = {
      directory: '/vault',
      state: 'watching',
      detail: 'ready',
      updatedAt: 1,
    };
    const nativeUpdate: NativeCrdtUpdate = {
      directory: '/vault',
      notebookId: 'notebook',
      conversationId: 'conversation',
      env: 'dev',
      updateBase64: 'AAA=',
    };
    listeners.get(NATIVE_SYNC_STATUS_EVENT)?.({ payload: nativeStatus });
    listeners.get(NATIVE_CRDT_UPDATE_EVENT)?.({ payload: nativeUpdate });

    expect(statuses).toEqual([nativeStatus]);
    expect(updates).toEqual([nativeUpdate]);
    stopStatus();
    stopUpdate();
    expect(unlistenStatus).toHaveBeenCalledOnce();
    expect(unlistenUpdate).toHaveBeenCalledOnce();
  });
});
