import React, { useEffect, useState } from 'react';
import { XmtpStatusIndicator } from '../components/xmtp/XmtpStatusIndicator';
import { IpfsStatusIndicator } from '../components/ipfs/IpfsStatusIndicator';
import { Info, Keyboard, Sun, Moon, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  getNativeRuntimeStatus,
  listenForNativeSyncStatus,
  pickNativeDirectory,
  startNativeWatch,
  stopNativeWatch,
  type NativeRuntimeStatus,
  type NativeSyncStatus,
} from '@/lib/nativeBridge';

interface TopBarProps {
  theme: 'light' | 'dark';
  toggleTheme: () => void;
  xmtpStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
  xmtpAddress: string | null;
  xmtpNetworkEnv: 'dev' | 'production'; // Pass this down
  onXmtpConnect: () => void; // Trigger connect from App
  onXmtpDisconnect: () => void; // Trigger disconnect from App
  onXmtpToggleNetwork: () => void; // Trigger network toggle from App
  onFileChange?: (event: React.ChangeEvent<HTMLInputElement>) => void;
  isImporting?: boolean;
  connectedNotebooksCount: number;
  hasIdentity: boolean;
  onCreateIdentity: () => void;
  activeConversationsCount: number;
  debugLoggingEnabled: boolean;
  setDebugLoggingEnabled: (enabled: boolean) => void;
}

export function TopBar({
  theme,
  toggleTheme,
  xmtpStatus,
  xmtpAddress,
  xmtpNetworkEnv,
  onXmtpConnect,
  onXmtpDisconnect,
  onXmtpToggleNetwork,
  onFileChange,
  isImporting = false,
  connectedNotebooksCount,
  hasIdentity,
  onCreateIdentity,
  activeConversationsCount,
  debugLoggingEnabled,
  setDebugLoggingEnabled,
}: TopBarProps) {
  const [showHotkeys, setShowHotkeys] = useState(false);
  const [runtimeStatus, setRuntimeStatus] = useState<NativeRuntimeStatus | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [nativeSyncStatus, setNativeSyncStatus] = useState<NativeSyncStatus | null>(null);
  const [nativeOperationPending, setNativeOperationPending] = useState(false);

  useEffect(() => {
    let active = true;
    void getNativeRuntimeStatus().then((status) => {
      if (active) setRuntimeStatus(status);
    }).catch((error: unknown) => {
      if (!active) return;
      setRuntimeError(error instanceof Error ? error.message : 'Native runtime probe failed');
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (runtimeStatus?.runtime !== 'desktop') return;
    let active = true;
    let unsubscribe: (() => void) | undefined;
    void listenForNativeSyncStatus((status) => {
      if (!active) return;
      setNativeSyncStatus(status);
      setRuntimeStatus((current) => {
        if (!current || current.runtime !== 'desktop') return current;
        const watched = new Set(current.watchedDirectories);
        if (status.state === 'watching') watched.add(status.directory);
        if (status.state === 'stopped') watched.delete(status.directory);
        return { ...current, watchedDirectories: [...watched].sort() };
      });
    }).then((stopListening) => {
      if (active) unsubscribe = stopListening;
      else stopListening();
    }).catch((error: unknown) => {
      if (active) setRuntimeError(error instanceof Error ? error.message : 'Native status listener failed');
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [runtimeStatus?.runtime]);

  const watchNativeVault = async () => {
    setNativeOperationPending(true);
    setRuntimeError(null);
    try {
      const directory = await pickNativeDirectory();
      if (!directory) return;
      const status = await startNativeWatch(directory);
      setNativeSyncStatus(status);
      const refreshed = await getNativeRuntimeStatus();
      setRuntimeStatus(refreshed);
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : 'Could not watch the linked vault');
    } finally {
      setNativeOperationPending(false);
    }
  };

  const stopWatchingNativeVault = async (directory: string) => {
    setNativeOperationPending(true);
    setRuntimeError(null);
    try {
      const status = await stopNativeWatch(directory);
      setNativeSyncStatus(status);
      setRuntimeStatus(await getNativeRuntimeStatus());
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : 'Could not stop the linked vault');
    } finally {
      setNativeOperationPending(false);
    }
  };
  const buildDate = new Date(__APP_BUILD_TIME__);
  const buildTimeLabel = Number.isNaN(buildDate.getTime())
    ? __APP_BUILD_TIME__
    : buildDate.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    });
  const shortCommitSha = __APP_COMMIT_SHA__ === 'unknown'
    ? __APP_COMMIT_SHA__
    : __APP_COMMIT_SHA__.slice(0, 7);

  return (
    <header
      className="sticky top-0 z-30 border-b border-gray-200/70 dark:border-gray-800/70 bg-white/70 dark:bg-gray-950/70 backdrop-blur-xl px-3 py-2"
      aria-label="Application toolbar"
    >
      <div className="flex flex-wrap items-center gap-3 justify-between">
        {/* Left side: App title */}
        <div className="flex items-center gap-2">
          <div className="h-9 w-9 rounded-2xl flex items-center justify-center">
            <img src="/logo.svg" alt="STORMDANCE Logo" className="h-full w-full" />
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-gray-500 dark:text-gray-400">STORMDANCE</p>
            <h1 className="text-lg font-bold leading-tight text-gray-900 dark:text-gray-50">storm.dance</h1>
          </div>
          <Dialog>
            <DialogTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-full text-gray-500 hover:bg-gray-200 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100"
                aria-label="Show app information"
              >
                <Info className="h-4 w-4" />
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Stormdance information</DialogTitle>
                <DialogDescription>
                  A local-first note-taking app for private notebooks, offline editing, encrypted backups, and optional XMTP collaboration.
                </DialogDescription>
              </DialogHeader>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 text-sm">
                <dt className="font-medium text-gray-600 dark:text-gray-300">Version</dt>
                <dd className="font-mono text-gray-900 dark:text-gray-100">{__APP_VERSION__}</dd>
                <dt className="font-medium text-gray-600 dark:text-gray-300">Build time</dt>
                <dd className="font-mono text-gray-900 dark:text-gray-100">
                  <time dateTime={__APP_BUILD_TIME__}>{buildTimeLabel}</time>
                </dd>
                <dt className="font-medium text-gray-600 dark:text-gray-300">Build ISO</dt>
                <dd className="break-all font-mono text-gray-900 dark:text-gray-100">{__APP_BUILD_TIME__}</dd>
                <dt className="font-medium text-gray-600 dark:text-gray-300">Commit</dt>
                <dd className="break-all font-mono text-gray-900 dark:text-gray-100">
                  {__APP_COMMIT_URL__ ? (
                    <a
                      href={__APP_COMMIT_URL__}
                      target="_blank"
                      rel="noreferrer"
                      className="text-teal-700 underline underline-offset-4 hover:text-teal-900 dark:text-teal-300 dark:hover:text-teal-100"
                    >
                      {shortCommitSha}
                    </a>
                  ) : (
                    shortCommitSha
                  )}
                </dd>
                <dt className="font-medium text-gray-600 dark:text-gray-300">Runtime</dt>
                <dd className="font-mono text-gray-900 dark:text-gray-100">
                  {runtimeStatus?.runtime === 'desktop' ? 'Tauri desktop' : 'Web browser'}
                </dd>
                <dt className="font-medium text-gray-600 dark:text-gray-300">Native sync</dt>
                <dd className="break-all font-mono text-gray-900 dark:text-gray-100">
                  {runtimeError
                    ? `Unavailable: ${runtimeError}`
                    : runtimeStatus?.runtime === 'desktop'
                      ? `${runtimeStatus.watchedDirectories.length} watched ${runtimeStatus.watchedDirectories.length === 1 ? 'vault' : 'vaults'} · ${runtimeStatus.platform}`
                      : 'Not required for web collaboration'}
                </dd>
              </dl>
              {runtimeStatus?.runtime === 'desktop' && (
                <section className="space-y-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700" aria-label="Native Markdown vault sync">
                  <div>
                    <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">Markdown vaults</h3>
                    <p className="text-xs text-gray-600 dark:text-gray-300">
                      Choose a directory already linked with the stormdance CLI. Ordinary Markdown edits then join this desktop XMTP session.
                    </p>
                  </div>
                  {runtimeStatus.watchedDirectories.length > 0 && (
                    <ul className="space-y-2 text-xs">
                      {runtimeStatus.watchedDirectories.map((directory) => (
                        <li key={directory} className="flex items-center justify-between gap-2">
                          <span className="min-w-0 break-all font-mono text-gray-700 dark:text-gray-200">{directory}</span>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={nativeOperationPending}
                            onClick={() => void stopWatchingNativeVault(directory)}
                          >
                            Stop
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={nativeOperationPending}
                    onClick={() => void watchNativeVault()}
                  >
                    {nativeOperationPending ? 'Working…' : 'Watch linked vault'}
                  </Button>
                  {nativeSyncStatus?.detail && (
                    <p role="status" className="text-xs text-gray-600 dark:text-gray-300">
                      {nativeSyncStatus.detail}
                    </p>
                  )}
                </section>
              )}
            </DialogContent>
          </Dialog>
        </div>

        {/* Right side: Status indicators and theme toggle */}
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {onFileChange && (
            <label
              className={`px-3 py-1.5 text-xs rounded-full flex items-center cursor-pointer transition-colors mobile-card bg-white/70 hover:bg-white dark:bg-gray-800 dark:hover:bg-gray-700 ${isImporting ? 'opacity-50 cursor-not-allowed' : ''
              }`}
              role="button"
              tabIndex={isImporting ? -1 : 0}
              aria-label="Import notebook backup"
              aria-disabled={isImporting}
              onKeyDown={(event) => {
                if ((event.key === 'Enter' || event.key === ' ') && !isImporting) {
                  event.preventDefault();
                  event.currentTarget.querySelector('input')?.click();
                }
              }}
            >
              <Upload size={14} className="mr-1.5" />
              Import
              <input
                type="file"
                className="hidden"
                accept=".json,.json.encrypted"
                onChange={onFileChange}
                disabled={isImporting}
                aria-label="Import notebook backup file"
              />
            </label>
          )}

          <div className="flex items-center gap-2 px-2 py-1 rounded-full bg-gray-100/80 dark:bg-gray-800/80">
            <IpfsStatusIndicator />
            <XmtpStatusIndicator
              status={xmtpStatus}
              address={xmtpAddress}
              networkEnv={xmtpNetworkEnv}
              onConnect={onXmtpConnect}
              onDisconnect={onXmtpDisconnect}
              onToggleNetwork={onXmtpToggleNetwork}
              connectedNotebooksCount={connectedNotebooksCount}
              hasIdentity={hasIdentity}
              onCreateIdentity={onCreateIdentity}
              activeConversationsCount={activeConversationsCount}
              debugLoggingEnabled={debugLoggingEnabled}
              setDebugLoggingEnabled={setDebugLoggingEnabled}
            />
          </div>

          <div className="relative">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setShowHotkeys((isOpen) => !isOpen)}
              className="h-9 w-9 rounded-full text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700"
              aria-label="Show browser-safe Obsidian hotkeys"
              aria-expanded={showHotkeys}
              aria-controls="hotkeys-panel"
            >
              <Keyboard className="h-4 w-4" />
            </Button>
            {showHotkeys && (
              <div
                id="hotkeys-panel"
                role="region"
                aria-label="Browser-safe Obsidian hotkeys"
                className="absolute right-0 top-full mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-gray-200 bg-white p-4 text-left text-xs shadow-xl dark:border-gray-700 dark:bg-gray-900"
              >
                <h2 className="mb-2 text-sm font-semibold text-gray-900 dark:text-gray-100">Browser-safe Obsidian hotkeys</h2>
                <p className="mb-3 text-gray-600 dark:text-gray-300">Use Ctrl+Alt on Windows/Linux or Cmd+Option on macOS.</p>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-gray-700 dark:text-gray-200">
                  <dt className="font-mono text-[11px] text-gray-900 dark:text-yellow-100">Ctrl+Alt+N</dt>
                  <dd>Create a note</dd>
                  <dt className="font-mono text-[11px] text-gray-900 dark:text-yellow-100">Ctrl+Alt+S</dt>
                  <dd>Confirm local save state</dd>
                  <dt className="font-mono text-[11px] text-gray-900 dark:text-yellow-100">Ctrl+Alt+[ / ]</dt>
                  <dd>Move across open note tabs</dd>
                  <dt className="font-mono text-[11px] text-gray-900 dark:text-yellow-100">Ctrl+Alt+1 / 2 / 3</dt>
                  <dd>Focus notebooks, notes, or editor</dd>
                  <dt className="font-mono text-[11px] text-gray-900 dark:text-yellow-100">Tab / Shift+Tab</dt>
                  <dd>Cycle columns when not typing</dd>
                </dl>
              </div>
            )}
          </div>

          <Button
            variant="ghost"
            size="icon"
            onClick={toggleTheme}
            className="h-9 w-9 rounded-full text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700"
            aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
          >
            {theme === 'light' ? <Moon className="h-4 w-4 text-yellow-600" /> : <Sun className="h-4 w-4 text-yellow-500" />}
          </Button>
        </div>
      </div>
    </header>
  );
}
