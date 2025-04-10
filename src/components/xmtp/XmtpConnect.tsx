import { useState, useEffect } from 'react';
import { Client } from '@xmtp/xmtp-js';
import { ethers } from 'ethers';
import { Button } from '@/components/ui/button';
import { Loader2, LogIn, LogOut, Wifi, WifiOff, MessageSquare, Network, Send, AlertCircle } from 'lucide-react';
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

type Conversation = {
  peerAddress: string;
  latestMessage?: {
    content: string;
    timestamp: string;
    sender: string;
  };
};

// XMTP Test bot address - consistent across both networks
const TEST_BOT_ADDRESS = "0x937C0d4a6294cdfa575de17382c7076b579DC176"; // gm.xmtp.eth

export function XmtpConnect({ onConnect, onDisconnect }: XmtpConnectProps) {
  const [_signer, setSigner] = useState<ethers.Signer | null>(null);
  const [_client, setClient] = useState<Client | null>(null);
  const [status, setStatus] = useState<Status>('disconnected');
  const [address, setAddress] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [isLoadingConversations, setIsLoadingConversations] = useState(false);
  const [convError, setConvError] = useState<string | null>(null);
  const [networkEnv, setNetworkEnv] = useState<XmtpEnv>('production');
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [isSendingTestMessage, setIsSendingTestMessage] = useState(false);
  
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
        setClient(xmtp);
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
        setClient(null);
        onDisconnect(); // Ensure parent state is cleared
    } finally {
        setIsReconnecting(false);
    }
  };

  const disconnectWallet = () => {
    addDebugLog("Disconnecting XMTP client...");
    setSigner(null);
    setClient(null);
    setStatus('disconnected');
    setAddress(null);
    setErrorMsg(null);
    setConversations([]);
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

  // Create and send a test message to the XMTP bot
  const sendTestMessage = async () => {
    if (!_client) {
      setConvError("No XMTP client available");
      return;
    }

    setIsSendingTestMessage(true);
    setConvError(null);
    
    try {
      addDebugLog(`Checking if can message test bot...`);
      const canMessage = await _client.canMessage(TEST_BOT_ADDRESS);
      addDebugLog(`Can message test bot: ${canMessage}`);
      
      if (!canMessage) {
        setConvError(`Cannot message test bot. The test bot may not be available on the ${networkEnv} network.`);
        return;
      }

      addDebugLog(`Creating new conversation with test bot...`);
      const conversation = await _client.conversations.newConversation(TEST_BOT_ADDRESS);
      addDebugLog(`Conversation created, topic: ${conversation.topic}`);
      
      const messageText = `Hello from storm.dance! This is a test message sent at ${new Date().toLocaleString()}`;
      addDebugLog(`Sending test message: "${messageText}"`);
      
      const message = await conversation.send(messageText);
      addDebugLog(`Message sent successfully, ID: ${message.id}`);
      
      // Wait a moment for the message to be processed
      addDebugLog(`Waiting for 3 seconds before checking for response...`);
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // List conversations after sending a message
      await listConversations();
      
      setConvError(`Test message sent successfully to gm.xmtp.eth! Check the conversations list.`);
    } catch (error: any) {
      addDebugLog(`ERROR: Failed to send test message: ${error.message}`);
      console.error("Failed to send test message:", error);
      setConvError(`Failed to send test message: ${error.message}`);
    } finally {
      setIsSendingTestMessage(false);
    }
  };

  const listConversations = async () => {
    if (!_client) {
      setConvError("No XMTP client available");
      return;
    }

    try {
      setIsLoadingConversations(true);
      setConvError(null);
      setConversations([]);
      
      addDebugLog(`Listing conversations for ${address} on ${networkEnv} network...`);
      
      // Wait a moment to ensure client is fully ready
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Try to see if the client can actually retrieve data
      try {
        addDebugLog(`Testing client with canMessage...`);
        const canMessage = await _client.canMessage(TEST_BOT_ADDRESS);
        addDebugLog(`Client can message test bot: ${canMessage}`);
      } catch (error: any) {
        addDebugLog(`WARNING: canMessage test failed: ${error.message}`);
      }
      
      const convList = await _client.conversations.list();
      addDebugLog(`Found ${convList.length} conversations`);
      
      const formattedConversations: Conversation[] = [];
      
      // Process each conversation with more details
      for (const conv of convList) {
        try {
          addDebugLog(`Processing conversation with ${conv.peerAddress} (topic: ${conv.topic})`);
          
          const conversation: Conversation = {
            peerAddress: conv.peerAddress
          };
          
          // Get latest message if available
          addDebugLog(`Fetching messages for conversation with ${conv.peerAddress}...`);
          const messages = await conv.messages({ limit: 1 });
          addDebugLog(`Found ${messages.length} messages for ${conv.peerAddress}`);
          
          if (messages.length > 0) {
            const latest = messages[0];
            conversation.latestMessage = {
              content: latest.content.toString().substring(0, 30) + (latest.content.toString().length > 30 ? '...' : ''),
              timestamp: new Date(latest.sent).toLocaleString(),
              sender: latest.senderAddress === _client.address ? 'You' : latest.senderAddress
            };
          }
          
          formattedConversations.push(conversation);
        } catch (err) {
          addDebugLog(`ERROR processing conversation: ${err instanceof Error ? err.message : String(err)}`);
          console.warn("Error processing conversation:", err);
        }
      }
      
      setConversations(formattedConversations);
      
      if (formattedConversations.length === 0) {
        // Check if we can message a test address
        try {
          const canMessage = await _client.canMessage(TEST_BOT_ADDRESS);
          addDebugLog(`Can message test bot (gm.xmtp.eth): ${canMessage}`);
          if (canMessage) {
            setConvError(`No conversations found on ${networkEnv} network. Try sending a test message to gm.xmtp.eth.`);
          } else {
            setConvError(`No conversations found on ${networkEnv} network and cannot message test bot. Network may be unavailable.`);
          }
        } catch (err) {
          addDebugLog(`ERROR checking if can message test bot: ${err instanceof Error ? err.message : String(err)}`);
          setConvError(`No conversations found on ${networkEnv} network and error checking test bot.`);
        }
      }
    } catch (e: any) {
      addDebugLog(`ERROR listing conversations: ${e.message}`);
      console.error("Error listing conversations:", e);
      setConvError(`Failed to list conversations: ${e.message || "Unknown error"}`);
    } finally {
      setIsLoadingConversations(false);
    }
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
      
      {/* Optional: Add UI for conversations list and test message */}
      {/* {status === 'connected' && (
        <div className="pt-2 border-t border-gray-200 dark:border-gray-700 space-y-1">
           <Button variant="outline" size="sm" onClick={sendTestMessage} disabled={isSendingTestMessage} className="text-xs w-full dark:text-gray-300 dark:border-gray-600 dark:hover:bg-gray-700 disabled:opacity-50">
              {isSendingTestMessage ? <Loader2 size={14} className="mr-1 animate-spin" /> : <Send size={14} className="mr-1" />}
              Send Test Message
            </Button>
            {convError && <p className="text-xs text-red-600 dark:text-red-400">{convError}</p>}
        </div>
      )} */}
    </div>
  );
} 