import React from 'react';
import { XmtpStatusIndicator } from '../components/xmtp/XmtpStatusIndicator';
import { IpfsStatusIndicator } from '../components/ipfs/IpfsStatusIndicator';
import { Sun, Moon, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';

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
}: TopBarProps) {
  return (
    <header className="sticky top-0 z-30 border-b border-gray-200/70 dark:border-gray-800/70 bg-white/70 dark:bg-gray-950/70 backdrop-blur-xl px-3 py-2">
      <div className="flex flex-wrap items-center gap-3 justify-between">
        {/* Left side: App title */}
        <div className="flex items-center gap-2">
          <div className="h-9 w-9 rounded-2xl bg-gradient-to-br from-yellow-300/80 to-orange-400/70 flex items-center justify-center shadow-sm shadow-yellow-200/60 dark:shadow-yellow-900/40">
            <span className="font-black text-gray-900 dark:text-gray-900">⚡</span>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-gray-500 dark:text-gray-400">storm</p>
            <h1 className="text-lg font-bold leading-tight text-gray-900 dark:text-gray-50">storm.dance</h1>
          </div>
        </div>

        {/* Right side: Status indicators and theme toggle */}
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {onFileChange && (
            <label className={`px-3 py-1.5 text-xs rounded-full flex items-center cursor-pointer transition-colors mobile-card bg-white/70 hover:bg-white dark:bg-gray-800 dark:hover:bg-gray-700 ${
              isImporting ? 'opacity-50 cursor-not-allowed' : ''
            }`}>
              <Upload size={14} className="mr-1.5" />
              Import
              <input
                  type="file"
                  className="hidden"
                  accept=".json,.json.encrypted"
                  onChange={onFileChange}
                  disabled={isImporting}
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
            />
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
