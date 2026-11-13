// Standalone production entry: serves the built UI and manages code-server
// without the Vite dev server. Run `vite build` first, then `npm run server`.
//
// Access model: every page and /api/code-server/* endpoint requires a session
// — either `Authorization: Bearer <PASSWORD>` or the HttpOnly session cookie
// issued by POST /api/code-server/login. Unauthenticated GETs receive the
// login page; nothing from dist/ is served until sign-in succeeds.
import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { join, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCodeServerManager, createRateLimiter, loadDotEnv } from './code-server-manager.mjs'

// server/ -> ide/ -> workspace/ -> repo root
const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const DIST = join(ROOT, 'workspace', 'mgmt-dashboard', 'dist')
const dotenv = loadDotEnv(join(ROOT, '.env'))
const PORT = Number(process.env.VITE_PORT ?? dotenv.VITE_PORT ?? 5173)

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
}

const LOGIN_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>vite-apps — sign in</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f172a;color:#e2e8f0;font-family:system-ui,-apple-system,sans-serif}
  .card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:2rem;width:min(380px,92vw);box-shadow:0 20px 50px rgb(0 0 0/.4)}
  h1{margin:0;font-size:1.6rem}.sub{margin:.25rem 0 1.5rem;color:#94a3b8}
  label{display:block;font-size:.85rem;color:#94a3b8;margin-bottom:.35rem}
  input{width:100%;box-sizing:border-box;padding:.55rem .75rem;border-radius:8px;border:1px solid #475569;background:#0f172a;color:#e2e8f0;font-size:.95rem}
  input:focus-visible{outline:2px solid #7dd3fc;outline-offset:1px;border-color:#7dd3fc}
  button{margin-top:1rem;width:100%;padding:.55rem 1.1rem;border-radius:8px;border:1px solid #0369a1;background:#0369a1;color:#e2e8f0;font-size:.95rem;cursor:pointer}
  button:hover{border-color:#7dd3fc}
  .err{color:#fca5a5;font-size:.85rem;min-height:1.2em;margin:.5rem 0 0}
  .hint{margin-top:1.25rem;font-size:.8rem;color:#64748b}
</style></head><body>
<main class="card"><h1>vite-apps</h1><p class="sub">Manager sign in</p>
<form id="login"><label for="pw">Password</label>
<input id="pw" type="password" autocomplete="current-password" required autofocus>
<p class="err" id="err"></p>
<button type="submit">Sign in</button></form>
<p class="hint">Uses the manager password from .env.</p></main>
<script>
document.getElementById('login').onsubmit = async (e) => {
  e.preventDefault()
  const r = await fetch('/api/code-server/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: document.getElementById('pw').value }),
  })
  if (r.ok) { location.reload(); return }
  document.getElementById('err').textContent = 'Incorrect password — try again.'
}
</script></body></html>`

function isSecureRequest(req) {
  return Boolean(req.socket.encrypted) || req.headers['x-forwarded-proto'] === 'https'
}

function readBody(req) {
  return new Promise((resolveBody) => {
    let data = ''
    req.on('data', (c) => { data += c; if (data.length > 8192) req.destroy() })
    req.on('end', () => {
      try { resolveBody(JSON.parse(data || '{}')) } catch { resolveBody({}) }
    })
  })
}

const manager = createCodeServerManager({ rootDir: ROOT })
manager.start()
const allowLogin = createRateLimiter({ windowMs: 60_000, max: 5 })

createServer((req, res) => {
  const url = (req.url || '/').split('?')[0]
  const ip = req.socket.remoteAddress || ''

  if (url.startsWith('/api/code-server')) {
    const action = url.slice('/api/code-server'.length)
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Cache-Control', 'no-store')

    if (action === '/login' && req.method === 'POST') {
      if (!allowLogin(ip)) {
        res.statusCode = 429
        res.end(JSON.stringify({ error: 'too many attempts' }))
        return
      }
      readBody(req).then((body) => {
        const token = manager.login(body?.password)
        if (!token) {
          res.statusCode = 401
          res.end(JSON.stringify({ error: 'unauthorized' }))
          return
        }
        res.setHeader('Set-Cookie', manager.sessionCookieHeader(token, isSecureRequest(req)))
        res.end(JSON.stringify({ ok: true }))
      })
      return
    }

    if (action === '/logout' && req.method === 'POST') {
      manager.logout(manager.sessionTokenFromReq(req))
      res.setHeader('Set-Cookie', 'vite_apps_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0')
      res.end(JSON.stringify({ ok: true }))
      return
    }

    if (action === '/status' && req.method === 'GET') {
      if (!manager.apiAuthorized(req)) {
        res.statusCode = 401
        res.end(JSON.stringify({ error: 'unauthorized' }))
      } else {
        res.end(JSON.stringify(manager.status()))
      }
    }
    else if (action === '/verify' && req.method === 'POST') {
      const ok = manager.apiAuthorized(req)
      res.statusCode = ok ? 200 : 401
      res.end(JSON.stringify(ok ? { ok: true } : { error: 'unauthorized' }))
    }
    else if ((action === '/start' || action === '/stop') && req.method === 'POST') {
      if (!manager.apiAuthorized(req)) {
        res.statusCode = 401
        res.end(JSON.stringify({ error: 'unauthorized' }))
      } else {
        res.end(JSON.stringify(action === '/start' ? manager.start() : manager.stop()))
      }
    } else { res.statusCode = 404; res.end('{}') }
    return
  }

  // Session gate: nothing under dist/ is served without auth. Unauthenticated
  // visitors get the self-contained login page instead.
  if (!manager.apiAuthorized(req)) {
    res.writeHead(401, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(LOGIN_PAGE)
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
  console.log(`vite-apps UI on http://localhost:${PORT}`)
})
