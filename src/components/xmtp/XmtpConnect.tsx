import { useState, useEffect } from 'react';
import { Client } from '@xmtp/xmtp-js';
import { ethers } from 'ethers';
import { Button } from '@/components/ui/button';
import { Loader2, LogIn, LogOut, Wifi, WifiOff, MessageSquare, Network, Send } from 'lucide-react';
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
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={listConversations} disabled={isLoadingConversations}>
            {isLoadingConversations ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <MessageSquare className="h-4 w-4 mr-2" />
            )}
            List Conversations
          </Button>
          <Button variant="outline" size="sm" onClick={disconnectWallet} title="Disconnect XMTP Client">
            <LogOut className="h-4 w-4 mr-2" />
            Disconnect
          </Button>
        </div>
      );
    }
    if (status === 'connecting' || isReconnecting) {
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
        <div className="flex items-center">
          <span className="font-medium flex items-center mr-3">{renderStatus()}</span>
          <Button 
            variant="ghost" 
            size="sm" 
            onClick={toggleNetwork}
            disabled={isReconnecting || status === 'connecting'}
            title={`Switch to ${networkEnv === 'dev' ? 'production' : 'dev'} network`}
            className="h-7 px-2 text-xs"
          >
            <Network className="h-3 w-3 mr-1" />
            {networkEnv === 'production' ? 'PROD' : 'DEV'}
          </Button>
        </div>
        {renderButton()}
      </div>

      {status === 'connected' && address && (
        <div className="text-xs flex items-center justify-between">
          <div className="text-gray-500 truncate" title={address}>
            Logged in as: {address}
          </div>
          <div className="text-gray-500">
            Network: {networkEnv}
          </div>
        </div>
      )}

      {status === 'error' && errorMsg && (
        <div className="text-xs text-red-600 mt-1 break-words">
          Error: {errorMsg}
        </div>
      )}
      
      {status === 'connected' && (
        <div className="mt-2 flex justify-between items-center">
          <Button 
            variant="secondary" 
            size="sm" 
            onClick={sendTestMessage} 
            disabled={isSendingTestMessage || isLoadingConversations}
            className="text-xs h-7 px-2"
          >
            {isSendingTestMessage ? (
              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
            ) : (
              <Send className="h-3 w-3 mr-1" />
            )}
            Send Test Message to Bot
          </Button>
          <div className="text-xs text-gray-500">
            Messages are only visible on the same network
          </div>
        </div>
      )}
      
      {/* Conversations section */}
      {conversations.length > 0 && (
        <div className="mt-3 border-t pt-2">
          <h3 className="font-medium mb-2">
            Your Conversations ({conversations.length}) 
            <span className="text-xs font-normal ml-2 text-gray-500">on {networkEnv} network</span>
          </h3>
          <div className="max-h-48 overflow-y-auto">
            {conversations.map((conv, index) => (
              <div key={index} className="mb-2 p-2 bg-gray-50 rounded-md text-xs">
                <div className="font-medium truncate" title={conv.peerAddress}>
                  Peer: {conv.peerAddress}
                </div>
                {conv.latestMessage ? (
                  <div className="mt-1 text-gray-600">
                    <div>Latest: "{conv.latestMessage.content}"</div>
                    <div className="flex justify-between mt-1">
                      <span>From: {conv.latestMessage.sender}</span>
                      <span>{conv.latestMessage.timestamp}</span>
                    </div>
                  </div>
                ) : (
                  <div className="mt-1 text-gray-500">No messages yet</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      
      {isLoadingConversations && (
        <div className="mt-3 flex items-center justify-center">
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          <span>Loading conversations...</span>
        </div>
      )}
      
      {convError && (
        <div className="mt-3 text-xs text-amber-600">
          {convError}
        </div>
      )}
    </div>
  );
} 