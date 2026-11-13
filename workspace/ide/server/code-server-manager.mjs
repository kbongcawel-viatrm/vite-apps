import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, createWriteStream, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import httpProxy from 'http-proxy'
import { timingSafeEqual, randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
// server/ -> ide/ -> workspace/ -> repo root
const ROOT = resolve(__dirname, '../../..')

/** Minimal .env parser (no dependency). Returns {} when file is absent. */
export function loadDotEnv(path = join(ROOT, '.env')) {
  const env = {}
  if (!existsSync(path)) return env
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!m) continue
    let v = m[2]
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    env[m[1]] = v
  }
  return env
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  // code-server needs inline styles/scripts, eval (workers), blob: workers and ws:.
  // Tighten further only after verifying the editor still works.
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss: http: https:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '),
}

// ---------------------------------------------------------------------------
// GitHub OAuth helpers (shared by the manager API and the edge proxy).
// Enabled only when GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET and a
// non-empty GITHUB_OAUTH_ALLOWED_USERS are all set.
// ---------------------------------------------------------------------------

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize'
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const GITHUB_USER_URL = 'https://api.github.com/user'

export function parseAllowedUsers(raw) {
  return new Set(String(raw || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))
}

export function githubAuthorizeUrl({ clientId, redirectUri, state }) {
  const u = new URL(GITHUB_AUTHORIZE_URL)
  u.searchParams.set('client_id', clientId)
  u.searchParams.set('redirect_uri', redirectUri)
  u.searchParams.set('scope', 'read:user')
  u.searchParams.set('state', state)
  return u.toString()
}

/** Exchange an OAuth code for the GitHub login, or null on any failure. */
export async function githubOAuthLogin({ clientId, clientSecret, code }) {
  try {
    const tokRes = await fetch(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    })
    const tok = await tokRes.json()
    if (!tok?.access_token) return null
    const userRes = await fetch(GITHUB_USER_URL, {
      headers: { Authorization: `Bearer ${tok.access_token}`, 'User-Agent': 'vite-apps' },
    })
    if (!userRes.ok) return null
    const user = await userRes.json()
    return user?.login ? String(user.login) : null
  } catch {
    return null
  }
}

function parseCookies(req) {
  const out = {}
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
  }
  return out
}

function requestIsSecure(req) {
  return Boolean(req.socket.encrypted) || req.headers['x-forwarded-proto'] === 'https'
}

/** Base URL for OAuth redirect URIs, derived from the incoming request. */
function requestBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || (requestIsSecure(req) ? 'https' : 'http')
  return `${proto}://${req.headers.host || 'localhost'}`
}

/** Perform a password login against the code-server backend; returns the
 *  value of its `code-server-session` cookie (the hashed password). */
function codeServerBackendLogin(internalPort, password) {
  return new Promise((resolveLogin) => {
    const body = `password=${encodeURIComponent(password)}`
    const r = httpRequest({
      host: '127.0.0.1', port: internalPort, path: '/login?to=/', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      const sc = res.headers['set-cookie'] || []
      for (const c of sc) {
        const m = String(c).match(/code-server-session=([^;]+)/)
        if (m) { res.resume(); resolveLogin(m[1]); return }
      }
      res.resume()
      resolveLogin(null)
    })
    r.on('error', () => resolveLogin(null))
    r.end(body)
  })
}

/** Fixed-window per-IP rate limiter. */
export function createRateLimiter({ windowMs, max }) {
  const hits = new Map()
  return function allow(ip) {
    const now = Date.now()
    let rec = hits.get(ip)
    if (!rec || now - rec.start > windowMs) {
      rec = { start: now, count: 0 }
      hits.set(ip, rec)
    }
    rec.count += 1
    if (hits.size > 10000) hits.clear() // bound memory
    return rec.count <= max
  }
}

export function createCodeServerManager({ rootDir = ROOT, logger = console } = {}) {
  // Accept both console-style (log/error) and Vite-style (info/error) loggers.
  const orig = logger
  const log = (...a) => (orig.info ?? orig.log).apply(orig, a)
  const error = (...a) => (orig.error ?? orig.warn ?? orig.log).apply(orig, a)
  logger = { log, error }

  const dotenv = loadDotEnv(join(rootDir, '.env'))
  const get = (k, d) => process.env[k] ?? dotenv[k] ?? d

  const dataDir = join(rootDir, '.code-server-data')
  const logsDir = join(dataDir, 'logs')
  const workspaceDir = resolve(rootDir, get('CODE_SERVER_WORKSPACE', './workspace'))
  const internalPort = Number(get('CODE_SERVER_PORT', '18080'))
  const edgePort = Number(get('EDGE_PORT', '8080'))
  const edgeBind = get('EDGE_BIND', '127.0.0.1')
  const password = get('PASSWORD', '')
  const publicEditorUrl = get('PUBLIC_EDITOR_URL', `http://localhost:${edgePort}`)
  const oauthClientId = get('GITHUB_OAUTH_CLIENT_ID', '')
  const oauthClientSecret = get('GITHUB_OAUTH_CLIENT_SECRET', '')
  const oauthAllowedUsers = parseAllowedUsers(get('GITHUB_OAUTH_ALLOWED_USERS', ''))
  const oauthEnabled = Boolean(oauthClientId && oauthClientSecret && oauthAllowedUsers.size)

  let child = null
  let edgeServer = null
  let proxy = null
  let state = 'stopped' // stopped | starting | running | error
  let lastError = null

  const binCandidates = [
    process.env.CODE_SERVER_BIN,
    join(rootDir, 'workspace', 'ide', 'bin', 'code-server'),
    join(rootDir, 'bin', 'code-server'), // legacy location
    'code-server',
  ].filter(Boolean)

  function findBinary() {
    for (const c of binCandidates) {
      if (c.includes('/') ? existsSync(c) : spawnSync('sh', ['-c', `command -v ${c}`], { stdio: 'ignore' }).status === 0) {
        return c
      }
    }
    return null
  }

  function installBinary() {
    const script = join(rootDir, 'workspace', 'ide', 'scripts', 'install-code-server.sh')
    if (!existsSync(script)) return false
    logger.log('[code-server] binary not found, running install script…')
    const r = spawnSync('bash', [script], { cwd: rootDir, stdio: 'inherit' })
    return r.status === 0 && existsSync(join(rootDir, 'workspace', 'ide', 'bin', 'code-server'))
  }

  function startEdgeProxy() {
    // The proxy outlives code-server restarts; only bind once.
    if (edgeServer) return Promise.resolve()
    mkdirSync(logsDir, { recursive: true })
    mkdirSync(workspaceDir, { recursive: true })

    const allowLogin = createRateLimiter({ windowMs: 60_000, max: 5 })
    const allowGeneral = createRateLimiter({ windowMs: 60_000, max: 600 })

    // Edge sessions for GitHub OAuth: token -> { expires, csCookie } where
    // csCookie is the code-server session cookie value obtained by logging
    // into the backend with PASSWORD on the user's behalf.
    const EDGE_SESSION_TTL_MS = 12 * 60 * 60 * 1000
    const edgeSessions = new Map()
    const EDGE_COOKIE = 'vite_apps_edge'
    const OAUTH_STATE_COOKIE = 'vite_apps_oauth_state'

    function edgeSessionValid(token) {
      const rec = token && edgeSessions.get(token)
      if (!rec) return null
      if (rec.expires < Date.now()) { edgeSessions.delete(token); return null }
      return rec
    }

    function edgeCookieHeader(token, secure, maxAge) {
      const attrs = [`${EDGE_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax']
      if (maxAge != null) attrs.push(`Max-Age=${maxAge}`)
      if (secure) attrs.push('Secure')
      return attrs.join('; ')
    }

    async function handleOAuth(req, res, path, query) {
      const secure = requestIsSecure(req)
      const base = requestBaseUrl(req)

      if (path === '/oauth/logout') {
        const tok = parseCookies(req)[EDGE_COOKIE]
        if (tok) edgeSessions.delete(tok)
        res.writeHead(302, {
          Location: '/login',
          'Set-Cookie': `${EDGE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
        })
        res.end()
        return true
      }

      if (path === '/oauth/start') {
        const state = randomBytes(16).toString('base64url')
        res.writeHead(302, {
          Location: githubAuthorizeUrl({
            clientId: oauthClientId,
            redirectUri: `${base}/oauth/callback`,
            state,
          }),
          'Set-Cookie': `${OAUTH_STATE_COOKIE}=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure ? '; Secure' : ''}`,
        })
        res.end()
        return true
      }

      if (path === '/oauth/callback') {
        const cookies = parseCookies(req)
        const stateOk = query.get('state') && query.get('state') === cookies[OAUTH_STATE_COOKIE]
        const clearState = `${OAUTH_STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
        if (!stateOk || !query.get('code')) {
          res.writeHead(400, { 'Content-Type': 'text/plain', 'Set-Cookie': clearState })
          res.end('OAuth state mismatch or missing code')
          return true
        }
        const ghLogin = await githubOAuthLogin({
          clientId: oauthClientId, clientSecret: oauthClientSecret, code: query.get('code'),
        })
        if (!ghLogin || !oauthAllowedUsers.has(ghLogin.toLowerCase())) {
          res.writeHead(403, { 'Content-Type': 'text/plain', 'Set-Cookie': clearState })
          res.end(ghLogin ? `GitHub user @${ghLogin} is not allowed` : 'GitHub login failed')
          return true
        }
        const csCookie = await codeServerBackendLogin(internalPort, password)
        if (!csCookie) {
          res.writeHead(502, { 'Content-Type': 'text/plain', 'Set-Cookie': clearState })
          res.end('Could not establish editor session')
          return true
        }
        const token = randomBytes(32).toString('base64url')
        edgeSessions.set(token, { expires: Date.now() + EDGE_SESSION_TTL_MS, csCookie })
        if (edgeSessions.size > 1000) edgeSessions.clear()
        res.writeHead(302, {
          Location: '/',
          'Set-Cookie': [clearState, edgeCookieHeader(token, secure, Math.floor(EDGE_SESSION_TTL_MS / 1000))],
        })
        res.end()
        return true
      }

      return false
    }

    proxy = httpProxy.createProxyServer({
      target: `http://127.0.0.1:${internalPort}`,
      ws: true,
      changeOrigin: false,
      xfwd: true,
    })
    proxy.on('error', (err, _req, res) => {
      logger.error('[edge] proxy error:', err.message)
      if (res && !res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' })
        res.end('Bad gateway')
      }
    })

    // Forward the request upstream, injecting the code-server session cookie
    // when the caller authenticated via GitHub OAuth at the edge.
    function injectEdgeSession(req) {
      const cookies = parseCookies(req)
      const rec = edgeSessionValid(cookies[EDGE_COOKIE])
      if (!rec) return false
      const parts = Object.entries(cookies)
        .filter(([k]) => k !== 'code-server-session' && k !== EDGE_COOKIE && k !== OAUTH_STATE_COOKIE)
        .map(([k, v]) => `${k}=${v}`)
      parts.push(`code-server-session=${rec.csCookie}`)
      req.headers.cookie = parts.join('; ')
      return true
    }

    proxy.on('proxyRes', (proxyRes, req, res) => {
      if (!req.__rewriteLogin) return
      const chunks = []
      proxyRes.on('data', (c) => chunks.push(c))
      proxyRes.on('end', () => {
        const headers = { ...proxyRes.headers }
        let body = Buffer.concat(chunks)
        const isHtml = String(headers['content-type'] || '').includes('text/html')
        const encoded = headers['content-encoding'] && headers['content-encoding'] !== 'identity'
        if (isHtml && !encoded) {
          const html = body.toString('utf8')
          if (html.includes('Password was set from')) {
            body = Buffer.from(html.replace(/<div class="sub">[\s\S]*?<\/div>/, ''), 'utf8')
            delete headers['content-length']
          }
        }
        res.writeHead(proxyRes.statusCode || 502, headers)
        res.end(body)
      })
    })

    edgeServer = createServer((req, res) => {
      const ip = req.socket.remoteAddress || 'unknown'
      const [path, qs] = (req.url || '/').split('?')
      const query = new URLSearchParams(qs || '')

      for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v)
      res.removeHeader?.('Server')

      if (oauthEnabled && path.startsWith('/oauth/')) {
        handleOAuth(req, res, path, query)
          .then((handled) => { if (!handled) { res.writeHead(404); res.end('not found') } })
          .catch((e) => {
            logger.error('[edge] oauth error:', e.message)
            if (!res.headersSent) { res.writeHead(500); res.end('oauth error') }
          })
        return
      }

      // Rate-limit the credential endpoint aggressively; everything else loosely.
      const isLogin = req.method === 'POST' && path === '/login'
      const limiter = isLogin ? allowLogin : allowGeneral
      if (!limiter(ip)) {
        res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '60' })
        res.end('Too many requests')
        return
      }

      if (oauthEnabled) {
        const cookies = parseCookies(req)
        if (!injectEdgeSession(req)) {
          const hasBackendSession = Boolean(cookies['code-server-session'])
          const isPasswordPath = path === '/login'
          if (!hasBackendSession && !isPasswordPath) {
            if (req.method === 'GET' || req.method === 'HEAD') {
              res.writeHead(302, { Location: '/oauth/start' })
              res.end()
            } else {
              res.writeHead(401, { 'Content-Type': 'text/plain' })
              res.end('Unauthorized')
            }
            return
          }
        }
      }

      // Strip the "$PASSWORD" hint from the code-server login page. Force an
      // identity response so the HTML can be rewritten (clients may send
      // Accept-Encoding: gzip, br through the Cloudflare/Caddy chain).
      req.__rewriteLogin = (req.method === 'GET' || req.method === 'POST') && path === '/login'
      if (req.__rewriteLogin) delete req.headers['accept-encoding']
      proxy.web(req, res, { selfHandleResponse: req.__rewriteLogin })
    })

    edgeServer.on('upgrade', (req, socket, head) => {
      if (oauthEnabled && !parseCookies(req)['code-server-session'] && !injectEdgeSession(req)) {
        socket.destroy()
        return
      }
      proxy.ws(req, socket, head)
    })

    return new Promise((resolvePromise, reject) => {
      edgeServer.once('error', reject)
      edgeServer.listen(edgePort, edgeBind, () => {
        logger.log(`[edge] hardened proxy listening on http://${edgeBind}:${edgePort}`)
        resolvePromise()
      })
    })
  }

  // Resolves once the previous code-server process has exited and the edge
  // proxy port is released, so a quick stop→start can't hit EADDRINUSE.
  let draining = Promise.resolve()
  let launching = false

  function start() {
    if (child || launching || state === 'starting') return status()
    if (!password) {
      state = 'error'
      lastError = 'PASSWORD is not set. Copy .env.example to .env and set a strong password.'
      return status()
    }
    state = 'starting'
    lastError = null
    launching = true
    draining.then(launch).catch((e) => {
      launching = false
      state = 'error'
      lastError = e.message
      logger.error('[code-server] launch failed:', e.message)
    })
    return status()
  }

  function launch() {
    if (child || state !== 'starting') { launching = false; return }

    let bin = findBinary()
    if (!bin && installBinary()) bin = join(rootDir, 'workspace', 'ide', 'bin', 'code-server')
    if (!bin) {
      launching = false
      state = 'error'
      lastError = 'code-server binary not found and automatic install failed. Run: npm run install:code-server'
      return
    }

    mkdirSync(logsDir, { recursive: true })
    mkdirSync(join(dataDir, 'user'), { recursive: true })
    mkdirSync(join(dataDir, 'extensions'), { recursive: true })

    const out = createWriteStream(join(logsDir, 'code-server.log'), { flags: 'a' })
    const err = createWriteStream(join(logsDir, 'code-server.err.log'), { flags: 'a' })

    const args = [
      '--bind-addr', `127.0.0.1:${internalPort}`,
      '--auth', 'password',
      '--cert', 'false',
      '--disable-telemetry',
      '--disable-update-check',
      '--disable-workspace-trust',
      '--user-data-dir', join(dataDir, 'user'),
      '--extensions-dir', join(dataDir, 'extensions'),
      '--welcome-text', 'vite-apps secure code mode',
      workspaceDir,
    ]

    // Never pass the password on the command line; code-server reads $PASSWORD.
    const proc = spawn(bin, args, {
      cwd: rootDir,
      env: { ...process.env, ...dotenv, PASSWORD: password },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child = proc
    launching = false
    proc.stdout.pipe(out)
    proc.stderr.pipe(err)

    proc.on('error', (e) => {
      if (child !== proc) return
      state = 'error'
      lastError = e.message
      logger.error('[code-server] spawn error:', e.message)
    })
    proc.on('exit', (code, signal) => {
      if (child !== proc) return
      logger.log(`[code-server] exited code=${code} signal=${signal}`)
      child = null
      state = 'stopped'
    })

    startEdgeProxy().catch((e) => {
      state = 'error'
      lastError = `edge proxy failed: ${e.message}`
      logger.error(lastError)
    })

    // Give code-server a moment, then mark running (it keeps running even if
    // the health check races startup; the proxy will 502 until ready).
    setTimeout(() => { if (child === proc) state = 'running' }, 1500)
  }

  function stop() {
    const proc = child
    child = null
    let procExit = Promise.resolve()
    if (proc) {
      procExit = new Promise((r) => proc.once('exit', r))
      proc.kill('SIGTERM')
      setTimeout(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL') }, 5000).unref()
    }
    let edgeClosed = Promise.resolve()
    if (edgeServer) {
      const s = edgeServer
      edgeServer = null
      s.closeIdleConnections?.()
      s.closeAllConnections?.()
      edgeClosed = new Promise((r) => s.close(() => r()))
    }
    proxy = null
    draining = Promise.all([procExit, edgeClosed]).then(() => {})
    state = 'stopped'
    return status()
  }

  // Manager API auth: every /api/code-server endpoint (including read-only
  // /status) requires either `Authorization: Bearer <PASSWORD>` — the same
  // secret code-server uses for login — or a valid session cookie issued by
  // /api/code-server/login. Sessions are random bearer tokens kept in
  // memory; they die with the process.
  const SESSION_COOKIE = 'vite_apps_session'
  const SESSION_TTL_MS = 12 * 60 * 60 * 1000
  const sessions = new Map() // token -> expiresAt

  function sessionTokenFromReq(req) {
    const header = req.headers.cookie || ''
    for (const part of header.split(';')) {
      const [k, ...rest] = part.trim().split('=')
      if (k === SESSION_COOKIE) return rest.join('=')
    }
    return null
  }

  function sessionValid(token) {
    if (!token) return false
    const exp = sessions.get(token)
    if (!exp) return false
    if (exp < Date.now()) { sessions.delete(token); return false }
    return true
  }

  function passwordMatches(attempt) {
    if (!password || typeof attempt !== 'string') return false
    const a = Buffer.from(attempt)
    const b = Buffer.from(password)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  function issueSession() {
    const token = randomBytes(32).toString('base64url')
    sessions.set(token, Date.now() + SESSION_TTL_MS)
    return token
  }

  function login(attempt) {
    if (!passwordMatches(attempt)) return null
    return issueSession()
  }

  function logout(token) {
    if (token) sessions.delete(token)
  }

  function sessionCookieHeader(token, secure) {
    const attrs = [
      `${SESSION_COOKIE}=${token}`,
      'Path=/', 'HttpOnly', 'SameSite=Strict',
      `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    ]
    if (secure) attrs.push('Secure')
    return attrs.join('; ')
  }

  function apiAuthorized(req) {
    const m = (req.headers['authorization'] || '').match(/^Bearer\s+(.+)$/i)
    if (m && passwordMatches(m[1])) return true
    return sessionValid(sessionTokenFromReq(req))
  }

  function status() {
    return {
      state,
      lastError,
      editorUrl: publicEditorUrl,
      workspaceDir,
      passwordConfigured: Boolean(password),
      pid: child?.pid ?? null,
    }
  }

  return {
    start, stop, status, apiAuthorized, login, logout,
    sessionTokenFromReq, sessionCookieHeader,
    createSession: issueSession,
    oauthEnabled,
    oauthConfig: { clientId: oauthClientId, clientSecret: oauthClientSecret, allowedUsers: oauthAllowedUsers },
  }
}
