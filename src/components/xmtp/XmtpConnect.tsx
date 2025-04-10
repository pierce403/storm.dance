import { useState, useEffect } from 'react';
import { Client } from '@xmtp/xmtp-js';
import { ethers } from 'ethers';
import { Button } from '@/components/ui/button';
import { Loader2, LogIn, LogOut, Wifi, WifiOff, Network, AlertCircle } from 'lucide-react';
import { createXmtpClientSafely, XmtpEnv } from '@/utils/xmtp-utils';

// Ensure proper types
declare global {
  interface Window {
    ethereum: any;
    process: any;
    Buffer: any;
  }
}

interface XmtpConnectProps {
  onConnect: (client: Client, address: string) => void;
  onDisconnect: () => void;
}

type Status = 'disconnected' | 'connecting' | 'connected' | 'error';

export function XmtpConnect({ onConnect, onDisconnect }: XmtpConnectProps) {
  const [_signer, setSigner] = useState<ethers.Signer | null>(null);
  const [status, setStatus] = useState<Status>('disconnected');
  const [address, setAddress] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [networkEnv, setNetworkEnv] = useState<XmtpEnv>('production');
  const [isReconnecting, setIsReconnecting] = useState(false);
  
  // Add log function to keep track of important debug information
  const addDebugLog = (message: string) => {
    const timestamp = new Date().toISOString().substring(11, 19);
    const logMsg = `${timestamp} - ${message}`;
    console.log(`XMTP-DEBUG: ${logMsg}`);
  };

  // Check on mount if Metamask is available
  useEffect(() => {
    if (!window.ethereum) {
        console.warn("XMTP Connect: Metamask or other Ethereum provider not found.");
        setStatus('error');
        setErrorMsg("No wallet provider found. Please install MetaMask.");
    }
  }, []);

  const connectWallet = async () => {
    addDebugLog(`Connecting wallet on ${networkEnv} network...`);
    if (!window.ethereum) {
        console.error("XMTP Connect: No Ethereum provider found.");
        setStatus('error');
        setErrorMsg("No wallet provider found.");
        return;
    }

    setStatus('connecting');
    setErrorMsg(null);

    try {
        // Using ethers v6 BrowserProvider
        const provider = new ethers.BrowserProvider(window.ethereum);
        addDebugLog("Requesting accounts from wallet...");
        await provider.send("eth_requestAccounts", []);
        const signerInstance = await provider.getSigner();
        setSigner(signerInstance);
        const userAddress = await signerInstance.getAddress();
        setAddress(userAddress);
        addDebugLog(`Signer obtained for address: ${userAddress}`);

        addDebugLog(`Creating XMTP client on ${networkEnv} network...`);
        // Use the utilities function instead of direct Client.create
        const xmtp = await createXmtpClientSafely(signerInstance, networkEnv);
        addDebugLog(`Client created successfully (${networkEnv}): ${xmtp.address}`);
        setStatus('connected');
        onConnect(xmtp, userAddress); // Notify parent

    } catch (error: any) {
        const errorMessage = error.message || "Connection failed. Check console.";
        addDebugLog(`ERROR: ${errorMessage}`);
        console.error("XMTP Connect: Error connecting wallet or creating client:", error);
        setStatus('error');
        setErrorMsg(errorMessage);
        setSigner(null);
        setAddress(null);
        onDisconnect(); // Ensure parent state is cleared
    } finally {
        setIsReconnecting(false);
    }
  };

  const disconnectWallet = () => {
    addDebugLog("Disconnecting XMTP client...");
    setSigner(null);
    setStatus('disconnected');
    setAddress(null);
    setErrorMsg(null);
    onDisconnect(); // Notify parent
    // Note: This doesn't disconnect from Metamask itself, just our app state
  };

  const toggleNetwork = async () => {
    if (status === 'connected') {
        setIsReconnecting(true);
        // Disconnect first
        disconnectWallet();
        
        // Toggle network
        const newEnv: XmtpEnv = networkEnv === 'dev' ? 'production' : 'dev';
        setNetworkEnv(newEnv);
        addDebugLog(`Switching to ${newEnv} network...`);
        
        // Small delay before reconnecting
        setTimeout(() => {
            connectWallet();
        }, 500);
    } else {
        // Just toggle the network if not connected
        const newEnv: XmtpEnv = networkEnv === 'dev' ? 'production' : 'dev';
        setNetworkEnv(newEnv);
        addDebugLog(`Switched to ${newEnv} network (not connected)`);
    }
  };

  const listConversations = async () => {
    if (status !== 'connected') {
      console.warn("Cannot list conversations: Not connected.")
      return;
    }
    // ... rest of listConversations (might need adjustment if _client was removed)
    // NOTE: This function might now be unused as well if nothing calls it.
  };

  // --- Render Logic ---

  const renderStatus = () => {
    switch (status) {
      case 'connected':
        return <span className="text-xs text-green-600 dark:text-green-400 flex items-center"><Wifi size={12} className="mr-1" /> Connected</span>;
      case 'connecting':
        return <span className="text-xs text-yellow-600 dark:text-yellow-400 flex items-center"><Loader2 size={12} className="mr-1 animate-spin" /> Connecting...</span>;
      case 'error':
        return <span className="text-xs text-red-600 dark:text-red-400 flex items-center"><AlertCircle size={12} className="mr-1" /> Error</span>;
      case 'disconnected':
      default:
        return <span className="text-xs text-gray-500 dark:text-gray-400 flex items-center"><WifiOff size={12} className="mr-1" /> Disconnected</span>;
    }
  };

  const renderButton = () => {
    switch (status) {
      case 'connected':
        return (
          <Button variant="outline" size="sm" onClick={disconnectWallet} className="text-xs dark:text-gray-300 dark:border-gray-600 dark:hover:bg-gray-700">
            <LogOut size={14} className="mr-1" /> Disconnect
          </Button>
        );
      case 'connecting':
      case 'error': // Show connect button even on error to allow retry
        return (
          <Button variant="outline" size="sm" onClick={connectWallet} disabled={status === 'connecting'} className="text-xs dark:text-gray-300 dark:border-gray-600 dark:hover:bg-gray-700 disabled:opacity-50">
            {status === 'connecting' ? (
              <Loader2 size={14} className="mr-1 animate-spin" />
            ) : (
              <LogIn size={14} className="mr-1" />
            )}
            {status === 'connecting' ? 'Connecting...' : 'Connect Wallet'}
          </Button>
        );
      case 'disconnected':
      default:
        return (
          <Button variant="outline" size="sm" onClick={connectWallet} className="text-xs dark:text-gray-300 dark:border-gray-600 dark:hover:bg-gray-700">
            <LogIn size={14} className="mr-1" /> Connect Wallet
          </Button>
        );
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        {renderButton()}
        <div className="flex items-center space-x-2">
           {renderStatus()}
           <Button 
              variant="ghost" 
              size="icon" 
              onClick={toggleNetwork} 
              disabled={isReconnecting || status === 'connecting'}
              title={`Switch to ${networkEnv === 'dev' ? 'Production' : 'Development'} Network`}
              className="h-6 w-6 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-50"
            >
             {isReconnecting ? <Loader2 size={14} className="animate-spin" /> : <Network size={14} />}
           </Button>
        </div>
      </div>
      {address && status === 'connected' && (
        <p className="text-xs text-gray-600 dark:text-gray-400 truncate" title={address}>
          Account: {address} ({networkEnv})
        </p>
      )}
      {errorMsg && (
        <p className="text-xs text-red-600 dark:text-red-400">{errorMsg}</p>
      )}
    </div>
  );
} 