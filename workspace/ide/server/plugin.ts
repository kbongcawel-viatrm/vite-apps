import type { Plugin } from 'vite'
import { createCodeServerManager, createRateLimiter } from './code-server-manager.mjs'

/**
 * Vite plugin that manages a hardened local code-server instance.
 *
 * - Spawns code-server bound to 127.0.0.1 only, password auth via $PASSWORD
 *   (never on the command line), telemetry/update checks disabled.
 * - Fronts it with a hardened edge proxy (security headers, login rate
 *   limiting, WebSocket support) on EDGE_PORT/EDGE_BIND from .env.
 * - Exposes /api/code-server/{status,start,stop} to the management UI.
 *
 * Works in both `vite dev` and `vite preview`. For production deployments
 * prefer `node server/standalone.mjs` after `vite build`.
 */
export function codeServerManager(): Plugin {
  let manager: ReturnType<typeof createCodeServerManager> | null = null
  let autostart = false

  const handler = {
    configureServer(server: any) {
      manager = createCodeServerManager({ logger: server.config.logger })
      mount(server.middlewares)
      autostart = process.env.CODE_SERVER_AUTOSTART !== '0'
      if (autostart) {
        // Start after the Vite server is listening.
        server.httpServer?.once('listening', () => manager?.start())
        if (!server.httpServer) manager.start()
      }
    },
    configurePreviewServer(server: any) {
      manager = createCodeServerManager({ logger: console })
      mount(server.middlewares)
      if (process.env.CODE_SERVER_AUTOSTART !== '0') manager.start()
    },
    buildEnd() {
      // Dev-only lifecycle: leave processes running across HMR restarts is
      // undesirable, but Vite doesn't give a clean "server closed" hook here.
    },
  }

  function mount(middlewares: any) {
    const allowLogin = createRateLimiter({ windowMs: 60_000, max: 5 })
    middlewares.use('/api/code-server', (req: any, res: any, next: any) => {
      const url = (req.url || '/').split('?')[0]
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Cache-Control', 'no-store')

      if (url === '/login' && req.method === 'POST') {
        if (!allowLogin(req.socket.remoteAddress || '')) {
          res.statusCode = 429
          res.end(JSON.stringify({ error: 'too many attempts' }))
          return
        }
        let body = ''
        req.on('data', (c: any) => { body += c; if (body.length > 8192) req.destroy() })
        req.on('end', () => {
          let password: unknown
          try { password = JSON.parse(body || '{}')?.password } catch { password = undefined }
          const token = manager!.login(password)
          if (!token) {
            res.statusCode = 401
            res.end(JSON.stringify({ error: 'unauthorized' }))
            return
          }
          const secure = Boolean(req.socket.encrypted) || req.headers['x-forwarded-proto'] === 'https'
          res.setHeader('Set-Cookie', manager!.sessionCookieHeader(token, secure))
          res.end(JSON.stringify({ ok: true }))
        })
      } else if (url === '/logout' && req.method === 'POST') {
        manager!.logout(manager!.sessionTokenFromReq(req))
        res.setHeader('Set-Cookie', 'vite_apps_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0')
        res.end(JSON.stringify({ ok: true }))
      } else if (url === '/status' && req.method === 'GET') {
        if (!manager!.apiAuthorized(req)) {
          res.statusCode = 401
          res.end(JSON.stringify({ error: 'unauthorized' }))
        } else {
          res.end(JSON.stringify(manager!.status()))
        }
      } else if (url === '/verify' && req.method === 'POST') {
        res.statusCode = manager!.apiAuthorized(req) ? 200 : 401
        res.end(JSON.stringify(manager!.apiAuthorized(req) ? { ok: true } : { error: 'unauthorized' }))
      } else if ((url === '/start' || url === '/stop') && req.method === 'POST') {
        if (!manager!.apiAuthorized(req)) {
          res.statusCode = 401
          res.end(JSON.stringify({ error: 'unauthorized' }))
        } else {
          res.end(JSON.stringify(url === '/start' ? manager!.start() : manager!.stop()))
        }
      } else {
        res.statusCode = 404
        res.end(JSON.stringify({ error: 'not found' }))
      }
    })
  }

  return {
    name: 'vite-apps:code-server-manager',
    ...handler,
  }
}
