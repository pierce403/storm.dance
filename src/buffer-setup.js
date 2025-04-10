// Direct import of the buffer module
import { Buffer as BufferModule } from 'buffer';

// Ensure Buffer is properly defined globally
if (typeof window !== 'undefined') {
  // Completely replace the Buffer implementation rather than extending it
  window.Buffer = BufferModule;
  
  // Explicitly expose critical methods used by XMTP
  window.Buffer.from = BufferModule.from.bind(BufferModule);
  window.Buffer.alloc = BufferModule.alloc.bind(BufferModule);
  window.Buffer.allocUnsafe = BufferModule.allocUnsafe.bind(BufferModule);
  window.Buffer.isBuffer = BufferModule.isBuffer.bind(BufferModule);
  window.Buffer.concat = BufferModule.concat.bind(BufferModule);
  
  // Test Base64 encoding which is critical for XMTP authentication
  try {
    const testString = "Test Buffer Functionality";
    const base64 = window.Buffer.from(testString).toString('base64');
    const decoded = window.Buffer.from(base64, 'base64').toString();
    
    if (decoded !== testString) {
      console.error("Buffer Base64 encoding/decoding test failed");
      // Force a complete replacement if test fails
      window.Buffer = BufferModule;
    } else {
      console.log("Buffer Base64 encoding/decoding verified successfully");
    }
  } catch (e) {
    console.error("Buffer test failed, forcing complete replacement:", e);
    window.Buffer = BufferModule;
  }
}

// Export for direct use if needed
export const Buffer = BufferModule; 