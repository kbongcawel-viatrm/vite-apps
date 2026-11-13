export interface CodeServerStatus {
  state: 'stopped' | 'starting' | 'running' | 'error'
  lastError: string | null
  editorUrl: string
  workspaceDir: string
  pid: number | null
}

export interface CodeServerManager {
  start(): CodeServerStatus
  stop(): CodeServerStatus
  status(): CodeServerStatus
}

export function loadDotEnv(path?: string): Record<string, string>
export function createCodeServerManager(options?: {
  rootDir?: string
  logger?: Pick<Console, 'log' | 'error'>
}): CodeServerManager
