import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, createWriteStream, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import httpProxy from 'http-proxy'

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
  const publicEditorUrl = get('PUBLIC_EDITOR_URL', `http://localhost:${edgePort}`)

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

    edgeServer = createServer((req, res) => {
      const ip = req.socket.remoteAddress || 'unknown'
      const path = (req.url || '/').split('?')[0]

      for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v)
      res.removeHeader?.('Server')

      // Rate-limit the credential endpoint aggressively; everything else loosely.
      const isLogin = req.method === 'POST' && path === '/login'
      const limiter = isLogin ? allowLogin : allowGeneral
      if (!limiter(ip)) {
        res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '60' })
        res.end('Too many requests')
        return
      }

      proxy.web(req, res)
    })

    edgeServer.on('upgrade', (req, socket, head) => {
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
      '--auth', 'none',
      '--cert', 'false',
      '--disable-telemetry',
      '--disable-update-check',
      '--disable-workspace-trust',
      '--user-data-dir', join(dataDir, 'user'),
      '--extensions-dir', join(dataDir, 'extensions'),
      workspaceDir,
    ]

    const proc = spawn(bin, args, {
      cwd: rootDir,
      env: { ...process.env, ...dotenv },
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

  function status() {
    return {
      state,
      lastError,
      editorUrl: publicEditorUrl,
      workspaceDir,
      pid: child?.pid ?? null,
    }
  }

  return { start, stop, status }
}
