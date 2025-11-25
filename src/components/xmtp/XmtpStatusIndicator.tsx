import { useState } from 'react';
import { Loader2, Wifi, WifiOff, AlertCircle } from 'lucide-react';
import { XmtpConnectionModal } from './XmtpConnectionModal';
import { Button } from '@/components/ui/button';

interface XmtpStatusIndicatorProps {
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  address: string | null;
  networkEnv: 'dev' | 'production';
  onConnect: () => void;
  onDisconnect: () => void;
  onToggleNetwork: () => void;
  connectedNotebooksCount: number;
  hasIdentity: boolean;
  onCreateIdentity: () => void;
  activeConversationsCount: number;
}

export function XmtpStatusIndicator({
  status,
  address,
  networkEnv,
  onConnect,
  onDisconnect,
  onToggleNetwork,
  connectedNotebooksCount,
  hasIdentity,
  onCreateIdentity,
  activeConversationsCount,
}: XmtpStatusIndicatorProps) {

  const [isModalOpen, setIsModalOpen] = useState(false);

  const renderStatus = () => {
    switch (status) {
      case 'connected':
        return (
          <div className="flex items-center">
            <div className="h-2 w-2 rounded-full bg-green-500 mr-2" />
            <span className="text-xs text-green-600 dark:text-green-400 flex items-center">
              <Wifi size={12} className="mr-1" /> XMTP
            </span>
          </div>
        );
      case 'connecting':
        return (
          <div className="flex items-center">
            <div className="h-2 w-2 rounded-full bg-yellow-500 animate-pulse mr-2" />
            <span className="text-xs text-yellow-600 dark:text-yellow-400 flex items-center">
              <Loader2 size={12} className="mr-1 animate-spin" /> XMTP
            </span>
          </div>
        );
      case 'error':
        return (
          <div className="flex items-center">
            <div className="h-2 w-2 rounded-full bg-red-500 mr-2" />
            <span className="text-xs text-red-600 dark:text-red-400 flex items-center">
              <AlertCircle size={12} className="mr-1" /> XMTP
            </span>
          </div>
        );
      case 'disconnected':
      default:
        return (
          <div className="flex items-center">
            <div className="h-2 w-2 rounded-full bg-gray-400 mr-2" />
            <span className="text-xs text-gray-500 dark:text-gray-400 flex items-center">
              <WifiOff size={12} className="mr-1" /> XMTP
            </span>
          </div>
        );
    }
  };

  return (
    <>
      <div
        className="flex items-center space-x-1 bg-gray-100 dark:bg-gray-800 rounded-md px-2 py-1 cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
        onClick={() => setIsModalOpen(true)}
      >
        <div className="flex items-center">
          {renderStatus()}
          {address && status === 'connected' && (
            <span className="ml-1 text-xs text-gray-500 dark:text-gray-400">
              ({networkEnv === 'dev' ? 'dev' : 'prod'})
            </span>
          )}
        </div>
      </div>

      <XmtpConnectionModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        status={status}
        networkEnv={networkEnv}
        onConnect={() => {
          onConnect();
          setIsModalOpen(false);
        }}
        onDisconnect={() => {
          onDisconnect();
          setIsModalOpen(false);
        }}
        onToggleNetwork={onToggleNetwork}
        address={address || undefined}
        connectedNotebooksCount={connectedNotebooksCount}
        hasIdentity={hasIdentity}
        onCreateIdentity={onCreateIdentity}
        activeConversationsCount={activeConversationsCount}
      />
    </>
  );
} 