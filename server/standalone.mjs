// Standalone production entry: serves the built UI and manages code-server
// without the Vite dev server. Run `vite build` first, then `npm run server`.
import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { join, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCodeServerManager } from './code-server-manager.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const DIST = join(ROOT, 'dist')
const PORT = Number(process.env.VITE_PORT || 5173)

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
}

const manager = createCodeServerManager({ rootDir: ROOT })
manager.start()

createServer((req, res) => {
  const url = (req.url || '/').split('?')[0]

  if (url.startsWith('/api/code-server')) {
    const action = url.slice('/api/code-server'.length)
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Cache-Control', 'no-store')
    if (action === '/status' && req.method === 'GET') res.end(JSON.stringify(manager.status()))
    else if (action === '/start' && req.method === 'POST') res.end(JSON.stringify(manager.start()))
    else if (action === '/stop' && req.method === 'POST') res.end(JSON.stringify(manager.stop()))
    else { res.statusCode = 404; res.end('{}') }
    return
  }

  // Static files from dist/ with path traversal protection.
  let file = join(DIST, url === '/' ? 'index.html' : url)
  file = resolve(file)
  if (!file.startsWith(DIST) || !existsSync(file) || !statSync(file).isFile()) {
    file = join(DIST, 'index.html')
    if (!existsSync(file)) { res.writeHead(503); res.end('Run `vite build` first'); return }
  }
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
  })
  createReadStream(file).pipe(res)
}).listen(PORT, () => {
  console.log(`vite-ide UI on http://localhost:${PORT}`)
})
