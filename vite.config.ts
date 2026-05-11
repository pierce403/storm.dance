import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [
    react(),
  ],
  define: {
    // Add buffer to global
    global: 'globalThis',
    'process.env': {},
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),

      // Explicitly use the browser-compatible Buffer implementation.
      "buffer": "buffer",
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
