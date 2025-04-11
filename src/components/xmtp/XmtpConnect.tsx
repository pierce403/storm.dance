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
  onConnect: (client: Client, address: string, env: XmtpEnv) => void;
  onDisconnect: () => void;
  onError?: (errorMessage: string) => void;
  initialNetworkEnv?: XmtpEnv;
  triggerConnect?: boolean;
  triggerDisconnect?: boolean;
}

export function XmtpConnect({ 
  onConnect,
  onDisconnect,
  onError,
  initialNetworkEnv = 'production',
  triggerConnect = false,
  triggerDisconnect = false,
}: XmtpConnectProps) {
  const [_signer, setSigner] = useState<ethers.Signer | null>(null);
  const [status, setStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected');
  const [address, setAddress] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [networkEnv, setNetworkEnv] = useState<XmtpEnv>(initialNetworkEnv);
  const [isInitializing, setIsInitializing] = useState(true);
  
  // Add log function to keep track of important debug information
  const addDebugLog = (message: string) => {
    const timestamp = new Date().toISOString().substring(11, 19);
    const logMsg = `${timestamp} - ${message}`;
    console.log(`XMTP-DEBUG: ${logMsg}`);
  };

  // Check on mount if Metamask is available
  useEffect(() => {
    const checkProvider = () => {
      if (!window.ethereum) {
          console.warn("XMTP Connect: Metamask or other Ethereum provider not found.");
          setStatus('error');
          setErrorMsg("No wallet provider found. Please install MetaMask.");
          if (onError) onError("No wallet provider found. Please install MetaMask.");
      }
    };
    
    checkProvider();
    setIsInitializing(false);
  }, [onError]);
  
  // Handle external triggers for connect/disconnect
  useEffect(() => {
    if (!isInitializing) {
      if (triggerConnect && status !== 'connecting' && status !== 'connected') {
        connectWallet();
      } else if (triggerDisconnect && status === 'connected') {
        disconnectWallet();
      }
    }
  }, [triggerConnect, triggerDisconnect, status, isInitializing]);

  const connectWallet = async () => {
    addDebugLog(`Connecting wallet on ${networkEnv} network...`);
    if (!window.ethereum) {
        const errMsg = "No Ethereum provider found.";
        console.error("XMTP Connect: " + errMsg);
        setStatus('error');
        setErrorMsg(errMsg);
        if (onError) onError(errMsg);
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
        onConnect(xmtp, userAddress, networkEnv); // Updated to pass networkEnv

    } catch (error: any) {
        const errorMessage = error.message || "Connection failed. Check console.";
        addDebugLog(`ERROR: ${errorMessage}`);
        console.error("XMTP Connect: Error connecting wallet or creating client:", error);
        setStatus('error');
        setErrorMsg(errorMessage);
        setSigner(null);
        setAddress(null);
        onDisconnect(); // Ensure parent state is cleared
        if (onError) onError(errorMessage);
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

  // This component no longer needs to render UI controls as these are now handled by XmtpStatusIndicator
  // Just render a minimal info element or return null
  
  return (
    <div className="text-xs text-gray-500 dark:text-gray-400">
      {status === 'connected' ? (
        <span>Connected to XMTP: {networkEnv}</span>
      ) : status === 'connecting' ? (
        <span>Connecting to XMTP...</span>
      ) : status === 'error' ? (
        <span className="text-red-500">{errorMsg || "Connection error"}</span>
      ) : (
        <span>XMTP not connected</span>
      )}
    </div>
  );
} 