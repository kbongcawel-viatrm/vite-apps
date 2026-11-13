import './style.css'

interface Status {
  state: 'stopped' | 'starting' | 'running' | 'error'
  lastError: string | null
  editorUrl: string
}

const app = document.querySelector<HTMLDivElement>('#app')!

const ACCESS_LOGOUT = 'https://home-security-xyz.cloudflareaccess.com/cdn-cgi/access/logout'

const GITHUB_ICON = `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744-.084-.729-.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>`

const badge = (state: Status['state']) => {
  const cls = {
    stopped: 'bg-gray-200 text-atom-muted',
    starting: 'bg-amber-100 text-amber-700',
    running: 'bg-green-100 text-green-700',
    error: 'bg-red-100 text-red-700',
  }[state]
  return `<span class="inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide ${cls}">${state}</span>`
}

const APPS = [
  { name: 'Editor', desc: 'code-server IDE', href: 'https://ide.home-security.uk' },
  { name: 'Files', desc: 'FTP file manager', href: 'https://files.home-security.uk' },
]

async function refresh() {
  const res = await fetch('/api/code-server/status')
  const s: Status = await res.json()

  app.innerHTML = `
    <div class="min-h-screen">
      <nav class="sticky top-0 z-10 border-b border-atom-border bg-white/80 backdrop-blur">
        <div class="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <a href="/" class="font-display text-xl font-bold text-atom-primary">vite-apps</a>
          <div class="flex items-center gap-2 text-sm">
            <a class="gh rounded-lg p-2 text-atom-muted hover:bg-atom-bg hover:text-atom-primary" href="https://github.com/kbongcawel-viatrm/vite-ide" target="_blank" rel="noopener" title="GitHub repository">${GITHUB_ICON}</a>
            <a href="${ACCESS_LOGOUT}" class="rounded-lg border border-atom-border px-4 py-2 font-medium text-atom-text transition hover:border-atom-primary hover:text-atom-primary">Log out</a>
          </div>
        </div>
      </nav>

      <header class="mx-auto max-w-5xl px-6 pb-10 pt-14 text-center">
        <h1 class="font-display text-4xl font-bold text-atom-text sm:text-5xl">Manager</h1>
        <p class="mt-3 text-atom-muted">code-server and services behind Cloudflare Access</p>
      </header>

      <main class="mx-auto grid max-w-5xl gap-6 px-6 pb-16 md:grid-cols-2">
        <section class="rounded-2xl border border-atom-border bg-white p-6 shadow-sm">
          <div class="flex items-center justify-between">
            <h2 class="font-display text-lg font-semibold">code-server</h2>
            ${badge(s.state)}
          </div>

          <dl class="mt-4 space-y-3 text-sm">
            <div class="flex justify-between gap-4 border-b border-atom-border pb-3">
              <dt class="text-atom-muted">Editor</dt>
              <dd class="truncate text-right"><a class="text-atom-primary hover:underline" href="${escapeHtml(s.editorUrl)}" target="_blank" rel="noopener">${escapeHtml(s.editorUrl)}</a></dd>
            </div>
            ${s.lastError ? `<div class="text-red-600">${escapeHtml(s.lastError)}</div>` : ''}
          </dl>

          <div class="mt-5 flex gap-3">
            ${s.state === 'running' || s.state === 'starting'
              ? `<button id="stop" class="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-700">Stop</button>`
              : `<button id="start" class="rounded-lg bg-atom-primary px-4 py-2 text-sm font-semibold text-white transition hover:bg-atom-primary-dark">Start code-server</button>`}
            <button id="refresh" class="rounded-lg border border-atom-border px-4 py-2 text-sm font-medium transition hover:border-atom-primary hover:text-atom-primary">Refresh</button>
          </div>
        </section>

        <section class="rounded-2xl border border-atom-border bg-white p-6 shadow-sm">
          <h2 class="font-display text-lg font-semibold">Apps</h2>
          <ul class="mt-4 divide-y divide-atom-border text-sm">
            ${APPS.map(
              (a) => `<li class="flex items-center justify-between py-3">
                <div><div class="font-medium">${a.name}</div><div class="text-atom-muted">${a.desc}</div></div>
                <a class="rounded-lg bg-atom-accent px-3 py-1.5 text-xs font-bold text-atom-text transition hover:brightness-95" href="${a.href}" target="_blank" rel="noopener">Open</a>
              </li>`,
            ).join('')}
          </ul>
        </section>
      </main>

      <footer class="border-t border-atom-border py-6 text-center text-xs text-atom-muted">
        vite-apps · gated by Cloudflare Access SSO
      </footer>
    </div>`

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
