import React from 'react';
import { Loader2, LogIn, LogOut, Wifi, WifiOff, AlertCircle, Network } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface XmtpStatusIndicatorProps {
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  address: string | null;
  networkEnv: 'dev' | 'production';
  onConnect: () => void;
  onDisconnect: () => void;
  onToggleNetwork: () => void;
}

export function XmtpStatusIndicator({
  status,
  address,
  networkEnv,
  onConnect,
  onDisconnect,
  onToggleNetwork,
}: XmtpStatusIndicatorProps) {
  
  const renderStatus = () => {
    switch (status) {
      case 'connected':
        return <span className="text-xs text-green-600 dark:text-green-400 flex items-center"><Wifi size={12} className="mr-1" /> XMTP</span>;
      case 'connecting':
        return <span className="text-xs text-yellow-600 dark:text-yellow-400 flex items-center"><Loader2 size={12} className="mr-1 animate-spin" /> XMTP</span>;
      case 'error':
        return <span className="text-xs text-red-600 dark:text-red-400 flex items-center"><AlertCircle size={12} className="mr-1" /> XMTP</span>;
      case 'disconnected':
      default:
        return <span className="text-xs text-gray-500 dark:text-gray-400 flex items-center"><WifiOff size={12} className="mr-1" /> XMTP</span>;
    }
  };

  const renderButton = () => {
    const isConnecting = status === 'connecting';
    
    if (status === 'connected') {
      return (
        <Button 
          variant="ghost" 
          size="sm" 
          onClick={onDisconnect} 
          className="h-7 p-1 text-xs dark:text-gray-300"
        >
          <LogOut size={12} className="mr-1" />
        </Button>
      );
    }
    
    return (
      <Button 
        variant="ghost" 
        size="sm" 
        onClick={onConnect} 
        disabled={isConnecting} 
        className="h-7 p-1 text-xs dark:text-gray-300 disabled:opacity-50"
      >
        {isConnecting ? <Loader2 size={12} className="mr-1 animate-spin" /> : <LogIn size={12} className="mr-1" />}
      </Button>
    );
  };

  return (
    <div className="flex items-center space-x-1 bg-gray-100 dark:bg-gray-800 rounded-md px-2 py-1">
      <div className="flex items-center">
        {renderStatus()}
        {address && status === 'connected' && (
          <span className="ml-1 text-xs text-gray-500 dark:text-gray-400">
            ({networkEnv === 'dev' ? 'dev' : 'prod'})
          </span>
        )}
      </div>
      
      <div className="flex items-center space-x-1">
        {renderButton()}
        <Button 
          variant="ghost" 
          size="icon" 
          onClick={onToggleNetwork} 
          title={`Switch to ${networkEnv === 'dev' ? 'Production' : 'Development'} Network`}
          className="h-6 w-6 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
        >
          <Network size={12} />
        </Button>
      </div>
    </div>
  );
} 