import { useState, useEffect } from 'react';
import { createBrowserClient } from '@xmtp/browser-sdk';
import type { BrowserClient } from '@xmtp/browser-sdk';
import type { XmtpEnv } from '@/utils/xmtp-utils';

interface XmtpConnectProps {
  onConnect: (client: BrowserClient, address: string, env: XmtpEnv) => void;
  onDisconnect: () => void;
  onError?: (errorMessage: string) => void;
  initialNetworkEnv?: XmtpEnv;
  triggerConnect?: boolean;
  triggerDisconnect?: boolean;
  isConnected?: boolean;
}

export function XmtpConnect({
  onConnect,
  onDisconnect,
  onError,
  initialNetworkEnv = 'dev',
  triggerConnect = false,
  triggerDisconnect = false,
  isConnected = false,
}: XmtpConnectProps) {
  const [status, setStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [networkEnv, setNetworkEnv] = useState<XmtpEnv>(initialNetworkEnv);
  const [isInitializing, setIsInitializing] = useState(true);

  const addDebugLog = (message: string) => {
    const timestamp = new Date().toISOString().substring(11, 19);
    console.log(`XMTP-DEBUG: ${timestamp} - ${message}`);
  };

  useEffect(() => {
    setIsInitializing(false);
  }, []);

  useEffect(() => {
    setNetworkEnv(initialNetworkEnv);
  }, [initialNetworkEnv]);

  useEffect(() => {
    if (!isInitializing) {
      if (triggerConnect && status !== 'connecting' && status !== 'connected') {
        connectClient();
      } else if (triggerDisconnect && status === 'connected') {
        disconnectClient();
      }
    }
  }, [triggerConnect, triggerDisconnect, status, isInitializing]);

  const connectClient = async () => {
    addDebugLog(`Creating ephemeral XMTP identity on ${networkEnv}`);
    setStatus('connecting');
    setErrorMsg(null);
    try {
      const { client, wallet } = await createBrowserClient({ env: networkEnv });
      addDebugLog(`Client created successfully: ${client.address}`);
      setStatus('connected');
      onConnect(client, wallet.address, networkEnv);
    } catch (error: any) {
      const errorMessage = error?.message || 'Connection failed. Check console.';
      addDebugLog(`ERROR: ${errorMessage}`);
      setStatus('error');
      setErrorMsg(errorMessage);
      onDisconnect();
      if (onError) onError(errorMessage);
    }
  };

  const disconnectClient = () => {
    addDebugLog('Disconnecting XMTP client...');
    setStatus('disconnected');
    setErrorMsg(null);
    onDisconnect();
  };

  return (
    <div className="text-xs text-gray-500 dark:text-gray-400">
      {status === 'connected' || isConnected ? (
        <span>Connected to XMTP: {networkEnv}</span>
      ) : status === 'connecting' ? (
        <span>Connecting to XMTP...</span>
      ) : status === 'error' ? (
        <span className="text-red-500">{errorMsg || 'Connection error'}</span>
      ) : (
        <span>XMTP not connected</span>
      )}
    </div>
  );
}
