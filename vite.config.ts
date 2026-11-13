import { defineConfig, loadEnv } from 'vite'
import { codeServerManager } from './server/plugin.ts'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [codeServerManager()],
    server: {
      port: Number(env.VITE_PORT || 5173),
      // The editor is served by the hardened edge proxy, not by Vite.
      proxy: {},
    },
    preview: {
      port: Number(env.VITE_PORT || 4173),
    },
  }
})
