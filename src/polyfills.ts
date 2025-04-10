// Polyfills for XMTP and crypto dependencies
import { Buffer } from 'buffer';
import * as processModule from 'process';

// Ensure process is globally available first
if (typeof window !== 'undefined') {
  // Define process if it doesn't exist
  if (!window.process) {
    window.process = processModule;
  }
  
  // Ensure env exists on process
  if (!window.process.env) {
    window.process.env = {};
  }

  // Define Buffer globally - force override to ensure complete implementation
  window.Buffer = Buffer;
  
  // Define global for libraries that expect it
  (window as any).global = window;
  
  // Add additional crypto polyfills that XMTP might need
  if (typeof window.crypto === 'undefined') {
    console.warn("Crypto API not found, some features might not work properly");
  }
}

export default function setupPolyfills() {
  console.log('Polyfills initialized');
  
  // Test critical Buffer functionality
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    console.log('Buffer implementation available');
  } else {
    console.error('Buffer implementation not properly initialized');
  }
} 