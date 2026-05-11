import { readFileSync } from "node:fs"
import { execSync } from "node:child_process"
import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8")
) as { version: string }

function readCommitSha() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA

  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim()
  } catch {
    return "unknown"
  }
}

const commitSha = readCommitSha()
const githubRepository = process.env.GITHUB_REPOSITORY || "pierce403/storm.dance"
const commitUrl = commitSha === "unknown" ? "" : `https://github.com/${githubRepository}/commit/${commitSha}`

export default defineConfig({
  plugins: [
    react(),
  ],
  define: {
    // Add buffer to global
    global: 'globalThis',
    'process.env': {},
    __APP_VERSION__: JSON.stringify(packageJson.version),
    __APP_BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __APP_COMMIT_SHA__: JSON.stringify(commitSha),
    __APP_COMMIT_URL__: JSON.stringify(commitUrl),
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
