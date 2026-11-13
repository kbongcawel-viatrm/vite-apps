import type { IncomingMessage } from 'node:http'

export interface CodeServerStatus {
  state: 'stopped' | 'starting' | 'running' | 'error'
  lastError: string | null
  editorUrl: string
  workspaceDir: string
  passwordConfigured: boolean
  pid: number | null
}

export interface CodeServerManager {
  start(): CodeServerStatus
  stop(): CodeServerStatus
  status(): CodeServerStatus
  apiAuthorized(req: IncomingMessage): boolean
  login(attempt: unknown): string | null
  logout(token: string | null): void
  sessionTokenFromReq(req: IncomingMessage): string | null
  sessionCookieHeader(token: string, secure: boolean): string
  createSession(): string
  oauthEnabled: boolean
  oauthConfig: {
    clientId: string
    clientSecret: string
    allowedUsers: Set<string>
  }
}

export function loadDotEnv(path?: string): Record<string, string>
export function createRateLimiter(options: { windowMs: number; max: number }): (key: string) => boolean
export function parseAllowedUsers(raw: string | undefined): Set<string>
export function githubAuthorizeUrl(options: { clientId: string; redirectUri: string; state: string }): string
export function githubOAuthLogin(options: {
  clientId: string
  clientSecret: string
  code: string
}): Promise<string | null>
export function createCodeServerManager(options?: {
  rootDir?: string
  logger?: Pick<Console, 'log' | 'error'>
}): CodeServerManager
