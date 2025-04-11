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
    <header className="border-b p-2 flex justify-between items-center bg-gray-50 dark:bg-gray-900 border-gray-200 dark:border-gray-700">
      {/* Left side: App title */}
      <div>
        <h1 className="text-xl font-bold">storm.dance</h1>
      </div>

      {/* Right side: Status indicators and theme toggle */}
      <div className="flex items-center space-x-3">
        {/* Import Button */}
        {onFileChange && (
          <label className={`px-2 py-1 text-xs rounded-md flex items-center cursor-pointer 
                          bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 
                          ${isImporting ? 'opacity-50 cursor-not-allowed' : ''}`}>
            <Upload size={12} className="mr-1"/>
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
        
        <IpfsStatusIndicator />
        <XmtpStatusIndicator
          status={xmtpStatus}
          address={xmtpAddress}
          networkEnv={xmtpNetworkEnv}
          onConnect={onXmtpConnect}
          onDisconnect={onXmtpDisconnect}
          onToggleNetwork={onXmtpToggleNetwork}
        />
        <Button
            variant="ghost"
            size="icon"
            onClick={toggleTheme}
            className="h-7 w-7 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
            aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
          >
            {theme === 'light' ? <Moon className="h-4 w-4 text-yellow-600" /> : <Sun className="h-4 w-4 text-yellow-500" />}
          </Button>
      </div>
    </header>
  );
} 