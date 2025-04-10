import { ethers } from 'ethers';
import { Client } from '@xmtp/xmtp-js';
// Import from our buffer setup file to ensure Buffer is properly initialized
import '../buffer-setup.js';

// This function wraps the XMTP client creation with additional polyfills and error handling
export async function createXmtpClientSafely(signer: ethers.Signer): Promise<Client> {
  console.log("Creating XMTP client with safety measures...");
  
  // Ensure process is available
  if (typeof process === 'undefined' || !process.env) {
    console.log("Defining process.env because it was missing");
    (window as any).process = (window as any).process || {};
    (window as any).process.env = (window as any).process.env || {};
  }
  
  // Verify Buffer is available and fully functioning
  if (typeof Buffer === 'undefined' || typeof Buffer.from !== 'function') {
    console.error("Buffer implementation issue detected, attempting to fix");
    
    // Dynamically import buffer module
    const bufferModule = await import('buffer');
    (window as any).Buffer = bufferModule.Buffer;
  }
  
  // Test Buffer.from with base64 specifically (this is what fails in XMTP)
  try {
    const testString = "XMTP Buffer Test";
    const base64 = Buffer.from(testString).toString('base64');
    const decoded = Buffer.from(base64, 'base64').toString();
    
    if (decoded !== testString) {
      throw new Error("Buffer base64 encoding/decoding test failed");
    }
    console.log("Buffer base64 test passed successfully");
  } catch (e) {
    console.error("Critical Buffer test failed:", e);
    throw new Error("Buffer implementation is not working correctly for base64 encoding. Please refresh or try a different browser.");
  }
  
  try {
    console.log("Attempting to create XMTP client...");
    
    // Create client with a timeout and explicit env setting
    const client = await Promise.race([
      Client.create(signer, { 
        env: "dev",
        skipContactPublishing: false,  // Ensure contacts are published
        persistConversations: true     // Ensure conversations are persisted
      }),
      new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error("XMTP client creation timeout")), 30000) // Increase timeout
      )
    ]) as Client;
    
    // Return the client first, then list conversations asynchronously
    // This ensures the app can continue without waiting for conversation listing
    console.log("XMTP client created successfully, client address:", client.address);
    
    // Wait a moment for the client to fully initialize before listing conversations
    setTimeout(async () => {
      try {
        // Verify client is still valid
        if (!client || !client.address) {
          console.log("Client no longer valid, skipping conversation listing");
          return;
        }
        
        console.log("Retrieving conversations for user:", client.address);
        
        // Add a small delay to ensure client is fully ready
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        const conversations = await client.conversations.list();
        console.log(`Found ${conversations.length} conversations:`);
        
        if (conversations.length > 0) {
          // Process each conversation with more details
          for (const conversation of conversations) {
            try {
              // Get latest messages in the conversation (up to 5)
              const messages = await conversation.messages({ limit: 5 });
              const latestMessage = messages.length > 0 ? messages[messages.length - 1] : null;
              
              console.log(`Conversation with ${conversation.peerAddress}`);
              if (latestMessage) {
                console.log(`- Latest message: "${latestMessage.content}" (${new Date(latestMessage.sent).toLocaleString()})`);
                console.log(`- Sender: ${latestMessage.senderAddress === client.address ? 'You' : latestMessage.senderAddress}`);
              } else {
                console.log('- No messages yet');
              }
              console.log('---');
            } catch (msgErr) {
              console.warn(`Error fetching messages for conversation with ${conversation.peerAddress}:`, msgErr);
            }
          }
          
          // Check if we can message a predefined test address
          try {
            const testAddress = "0x937C0d4a6294cdfa575de17382c7076b579DC176"; // gm.xmtp.eth bot
            const canMessage = await client.canMessage(testAddress);
            console.log(`Can message test bot (gm.xmtp.eth): ${canMessage}`);
          } catch (err) {
            console.warn("Error checking if can message test address:", err);
          }
        } else {
          console.log("No existing conversations found");
          console.log("Tip: Message gm.xmtp.eth (0x937C0d4a6294cdfa575de17382c7076b579DC176) to get an automated reply");
        }
      } catch (e) {
        console.warn("Could not retrieve conversations:", e);
      }
    }, 2000); // Wait 2 seconds before trying to list conversations
    
    return client;
  } catch (error: any) {
    console.error("Failed to create XMTP client:", error);
    
    // Provide more specific error messages based on the error type
    if (error.message?.includes("Unauthenticated") || error.message?.includes("illegal base64")) {
      throw new Error("Authentication with XMTP failed. This may be due to a Buffer encoding issue. Please try refreshing the page.");
    }
    
    throw error;
  }
} 