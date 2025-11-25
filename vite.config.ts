import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      // Focus specifically on what XMTP needs
      include: ['buffer', 'process', 'stream', 'events', 'crypto', 'util'],
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
      protocolImports: true,
    })
  ],
  define: {
    // Add buffer to global
    global: 'globalThis',
    'process.env': {},
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),

      // Explicitly use browser-compatible versions
      "buffer": "buffer",
      "crypto": "crypto-browserify",
      "stream": "stream-browserify",
    },
  },
  optimizeDeps: {
    include: ['buffer'],
    esbuildOptions: {
      define: {
        global: 'globalThis'
      }
    }
  },
  assetsInclude: ['**/*.wasm'],
  build: {
    commonjsOptions: {
      transformMixedEsModules: true,
    },
  },
})

