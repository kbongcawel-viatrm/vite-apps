import './style.css'

interface Status {
  state: 'stopped' | 'starting' | 'running' | 'error'
  lastError: string | null
  editorUrl: string
  passwordConfigured: boolean
}

const app = document.querySelector<HTMLDivElement>('#app')!
const KEY = 'vite-apps-key'

function authHeaders(): Record<string, string> {
  const k = sessionStorage.getItem(KEY)
  return k ? { Authorization: `Bearer ${k}` } : {}
}

async function api(path: string, opts: RequestInit = {}): Promise<Response> {
  return fetch(path, {
    ...opts,
    headers: { ...authHeaders(), ...(opts.headers || {}) },
  })
}

let authed = false

function showLogin(message = '') {
  authed = false
  app.innerHTML = `
    <main class="card login">
      <h1>vite-apps</h1>
      <p class="sub">Manager sign in</p>
      <form id="login">
        <label for="pw">Password</label>
        <input id="pw" type="password" autocomplete="current-password" required autofocus />
        ${message ? `<p class="row error"><span></span><span>${escapeHtml(message)}</span></p>` : ''}
        <div class="actions"><button class="primary" type="submit">Sign in</button></div>
      </form>
      <p class="hint">Uses the manager password from .env.</p>
    </main>`
  const form = document.getElementById('login') as HTMLFormElement
  form.onsubmit = async (e) => {
    e.preventDefault()
    const pw = (document.getElementById('pw') as HTMLInputElement).value
    const r = await api('/api/code-server/verify', {
      method: 'POST',
      headers: { Authorization: `Bearer ${pw}` },
    })
    if (r.status === 401) { showLogin('Incorrect password — try again.'); return }
    sessionStorage.setItem(KEY, pw)
    authed = true
    refresh()
  }
}

function badge(state: Status['state']) {
  const cls = { stopped: 'off', starting: 'warn', running: 'on', error: 'err' }[state]
  return `<span class="badge ${cls}">${state}</span>`
}

async function refresh() {
  const res = await api('/api/code-server/status')
  if (res.status === 401) { showLogin(); return }
  const s: Status = await res.json()
  authed = true

  app.innerHTML = `
    <main class="card">
      <h1>vite-apps</h1>
      <p class="sub">Secure code-server manager</p>

      <div class="row"><span>Status</span>${badge(s.state)}</div>
      <div class="row"><span>Editor</span><a href="${escapeHtml(s.editorUrl)}" target="_blank" rel="noopener">${escapeHtml(s.editorUrl)}</a></div>
      ${s.lastError ? `<div class="row error"><span>Error</span><span>${escapeHtml(s.lastError)}</span></div>` : ''}
      ${!s.passwordConfigured ? `<div class="row error"><span>Config</span><span>Set PASSWORD in .env (see .env.example)</span></div>` : ''}

      <div class="actions">
        ${s.state === 'running' || s.state === 'starting'
          ? `<button id="stop" class="danger">Stop</button>`
          : `<button id="start" class="primary">Start code-server</button>`}
        <button id="refresh">Refresh</button>
        <button id="logout">Sign out</button>
      </div>
    </main>`

  document.getElementById('refresh')!.onclick = refresh
  document.getElementById('logout')!.onclick = () => {
    sessionStorage.removeItem(KEY)
    showLogin()
  }
  document.getElementById('start')?.addEventListener('click', async () => {
    const r = await api('/api/code-server/start', { method: 'POST' })
    if (r.status === 401) { showLogin('Incorrect password.'); return }
    setTimeout(refresh, 800)
  })
  document.getElementById('stop')?.addEventListener('click', async () => {
    const r = await api('/api/code-server/stop', { method: 'POST' })
    if (r.status === 401) { showLogin('Incorrect password.'); return }
    setTimeout(refresh, 300)
  })
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

refresh()
setInterval(() => { if (authed) refresh() }, 5000)
