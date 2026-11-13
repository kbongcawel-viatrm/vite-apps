import { defineConfig, loadEnv } from 'vite'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import { codeServerManager } from '../ide/server/plugin.ts'

// Repo root — .env and runtime data live two levels up.
const ROOT = fileURLToPath(new URL('../../', import.meta.url))

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ROOT, '')
  return {
    plugins: [tailwindcss(), codeServerManager()],
    server: {
      port: Number(env.VITE_PORT || 5173),
      strictPort: true,
      // The editor is served by the hardened edge proxy, not by Vite.
      proxy: {},
    },
    preview: {
      port: Number(env.VITE_PORT || 4173),
    },
  }
})
