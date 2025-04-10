// Initialize Node.js compatibility objects
// This script runs before any other JavaScript

// Initialize process
if (typeof process === 'undefined') {
  window.process = {
    env: {},
    nextTick: function(cb) { setTimeout(cb, 0); },
    browser: true
  };
}

// Initialize Buffer with a proper implementation
if (typeof Buffer === 'undefined') {
  // A more complete Buffer polyfill implementation
  window.Buffer = {
    from: function(data, encoding) {
      // Basic implementation of Buffer.from for strings
      if (typeof data === 'string') {
        const arr = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i++) {
          arr[i] = data.charCodeAt(i) & 0xff;
        }
        return arr;
      }
      // Handle array-like objects
      if (Array.isArray(data) || data instanceof Uint8Array) {
        return new Uint8Array(data);
      }
      // Default fallback
      console.warn("Buffer.from received unsupported data type:", typeof data);
      return new Uint8Array();
    },
    alloc: function(size) {
      return new Uint8Array(size);
    },
    isBuffer: function(obj) { 
      return obj instanceof Uint8Array; 
    }
  };
}

// Set global reference
if (typeof global === 'undefined') {
  window.global = window;
}

console.log('Environment initialization complete with enhanced Buffer support'); 