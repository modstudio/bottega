import { isAbsolute, resolve } from 'node:path'

/** Resolve a project-local executable path while leaving PATH lookups and absolute paths alone. */
export function resolveProjectMcpCommand(command: string, cwd: string): string {
  return command.includes('/') && !isAbsolute(command) ? resolve(cwd, command) : command
}
