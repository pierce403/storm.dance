// This script will be replaced during build with the actual buffer implementation
(function() {
  try {
    // Use the buffer-es6 polyfill if available
    var bufferPolyfill = {
      Buffer: {
        from: function(data, encoding) {
          if (typeof data === 'string') {
            var len = data.length;
            var buf = new Uint8Array(len);
            for (var i = 0; i < len; i++) {
              buf[i] = data.charCodeAt(i);
            }
            buf.toString = function() { return data; };
            return buf;
          }
          if (Array.isArray(data)) {
            return new Uint8Array(data);
          }
          return new Uint8Array();
        },
        alloc: function(size) {
          return new Uint8Array(size);
        },
        isBuffer: function(obj) {
          return obj instanceof Uint8Array;
        }
      }
    };

    // Set global Buffer or merge with existing implementation
    if (typeof window.Buffer === 'undefined') {
      window.Buffer = bufferPolyfill.Buffer;
    } else {
      // Enhance existing implementation if needed
      if (typeof window.Buffer.from !== 'function') {
        window.Buffer.from = bufferPolyfill.Buffer.from;
      }
      if (typeof window.Buffer.alloc !== 'function') {
        window.Buffer.alloc = bufferPolyfill.Buffer.alloc;
      }
      if (typeof window.Buffer.isBuffer !== 'function') {
        window.Buffer.isBuffer = bufferPolyfill.Buffer.isBuffer;
      }
    }

    console.log('Buffer polyfill installed');
  } catch (e) {
    console.error('Failed to install Buffer polyfill:', e);
  }
})(); 