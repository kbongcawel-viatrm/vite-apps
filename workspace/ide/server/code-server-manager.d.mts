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
  apiAuthorized(req: { headers: Record<string, string | string[] | undefined> }): boolean
}

export function loadDotEnv(path?: string): Record<string, string>
export function createCodeServerManager(options?: {
  rootDir?: string
  logger?: Pick<Console, 'log' | 'error'>
}): CodeServerManager
