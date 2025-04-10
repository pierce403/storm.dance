import { useState, useEffect } from 'react';
import { Client } from '@xmtp/xmtp-js';
import { ethers } from 'ethers';
import { Button } from '@/components/ui/button';
import { Loader2, LogIn, LogOut, Wifi, WifiOff } from 'lucide-react';
import { createXmtpClientSafely } from '@/utils/xmtp-utils';

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
  const [_client, setClient] = useState<Client | null>(null);
  const [status, setStatus] = useState<Status>('disconnected');
  const [address, setAddress] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Check on mount if Metamask is available
  useEffect(() => {
    if (!window.ethereum) {
        console.warn("XMTP Connect: Metamask or other Ethereum provider not found.");
        setStatus('error');
        setErrorMsg("No wallet provider found. Please install MetaMask.");
    }
  }, []);

  const connectWallet = async () => {
    console.log("XMTP Connect: Attempting to connect wallet...");
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
        console.debug("XMTP Connect: Requesting accounts...");
        await provider.send("eth_requestAccounts", []);
        const signerInstance = await provider.getSigner();
        setSigner(signerInstance);
        const userAddress = await signerInstance.getAddress();
        setAddress(userAddress);
        console.debug(`XMTP Connect: Signer obtained for address: ${userAddress}`);

        console.debug("XMTP Connect: Creating XMTP client...");
        // Use the utilities function instead of direct Client.create
        const xmtp = await createXmtpClientSafely(signerInstance);
        console.info(`XMTP Connect: Client created successfully for address: ${xmtp.address}`);
        setClient(xmtp);
        setStatus('connected');
        onConnect(xmtp, userAddress); // Notify parent

    } catch (error: any) {
        console.error("XMTP Connect: Error connecting wallet or creating client:", error);
        setStatus('error');
        setErrorMsg(error.message || "Connection failed. Check console.");
        setSigner(null);
        setAddress(null);
        setClient(null);
        onDisconnect(); // Ensure parent state is cleared
    }
  };

  const disconnectWallet = () => {
    console.log("XMTP Connect: Disconnecting...");
    setSigner(null);
    setClient(null);
    setStatus('disconnected');
    setAddress(null);
    setErrorMsg(null);
    onDisconnect(); // Notify parent
    // Note: This doesn't disconnect from Metamask itself, just our app state
  };

  // --- Render Logic ---

  const renderStatus = () => {
    switch (status) {
      case 'connecting':
        return <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Connecting...</>;
      case 'connected':
        return <><Wifi className="h-4 w-4 mr-2 text-green-500" /> Connected</>;
      case 'error':
        return <><WifiOff className="h-4 w-4 mr-2 text-red-500" /> Error</>;
      case 'disconnected':
      default:
        return <><WifiOff className="h-4 w-4 mr-2 text-gray-500" /> Disconnected</>;
    }
  };

  const renderButton = () => {
    if (status === 'connected' && address) {
      return (
        <Button variant="outline" size="sm" onClick={disconnectWallet} title="Disconnect XMTP Client">
          <LogOut className="h-4 w-4 mr-2" />
          Disconnect
        </Button>
      );
    }
    if (status === 'connecting') {
       return (
         <Button variant="outline" size="sm" disabled>
            <Loader2 className="h-4 w-4 animate-spin" />
         </Button>
       );
    }
    // Show connect button if disconnected or error (and provider exists)
    if ((status === 'disconnected' || status === 'error') && window.ethereum) {
       return (
        <Button variant="outline" size="sm" onClick={connectWallet}>
            <LogIn className="h-4 w-4 mr-2" />
            Connect Wallet
        </Button>
       );
    }
    // If error and no provider, show nothing or disabled state
    return null; 
  };

  return (
    <div className="p-3 border-b text-sm">
      <div className="flex items-center justify-between mb-1">
        <span className="font-medium flex items-center">{renderStatus()}</span>
        {renderButton()}
      </div>
      {status === 'connected' && address && (
        <div className="text-xs text-gray-500 truncate" title={address}>
          Logged in as: {address}
        </div>
      )}
      {status === 'error' && errorMsg && (
        <div className="text-xs text-red-600 mt-1 break-words">
          Error: {errorMsg}
        </div>
      )}
    </div>
  );
} 