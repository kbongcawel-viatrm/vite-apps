import './style.css'

interface Status {
  state: 'stopped' | 'starting' | 'running' | 'error'
  lastError: string | null
  editorUrl: string
  workspaceDir: string
  passwordConfigured: boolean
  pid: number | null
}

const app = document.querySelector<HTMLDivElement>('#app')!

function badge(state: Status['state']) {
  const cls = { stopped: 'off', starting: 'warn', running: 'on', error: 'err' }[state]
  return `<span class="badge ${cls}">${state}</span>`
}

async function refresh() {
  const s: Status = await (await fetch('/api/code-server/status')).json()

  app.innerHTML = `
    <main class="card">
      <h1>vite-ide</h1>
      <p class="sub">Secure code-server manager</p>

      <div class="row"><span>Status</span>${badge(s.state)}</div>
      ${s.pid ? `<div class="row"><span>PID</span><code>${s.pid}</code></div>` : ''}
      <div class="row"><span>Workspace</span><code>${escapeHtml(s.workspaceDir)}</code></div>
      <div class="row"><span>Editor</span><a href="${escapeHtml(s.editorUrl)}" target="_blank" rel="noopener">${escapeHtml(s.editorUrl)}</a></div>
      ${s.lastError ? `<div class="row error"><span>Error</span><span>${escapeHtml(s.lastError)}</span></div>` : ''}
      ${!s.passwordConfigured ? `<div class="row error"><span>Config</span><span>Set PASSWORD in .env (see .env.example)</span></div>` : ''}

      <div class="actions">
        ${s.state === 'running' || s.state === 'starting'
          ? `<button id="stop" class="danger">Stop</button>`
          : `<button id="start" class="primary">Start code-server</button>`}
        <button id="refresh">Refresh</button>
      </div>

      <p class="hint">
        The editor runs behind a hardened local proxy: password auth, security
        headers, and login rate limiting. For remote access, put TLS in front
        (see deploy/Caddyfile) — never expose port ${'${EDGE_PORT}'} directly.
      </p>
    </main>`

  document.getElementById('refresh')!.onclick = refresh
  document.getElementById('start')?.addEventListener('click', async () => {
    await fetch('/api/code-server/start', { method: 'POST' })
    setTimeout(refresh, 800)
  })
  document.getElementById('stop')?.addEventListener('click', async () => {
    await fetch('/api/code-server/stop', { method: 'POST' })
    setTimeout(refresh, 300)
  })
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

refresh()
setInterval(refresh, 5000)
