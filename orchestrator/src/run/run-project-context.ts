// concern: run project context
import { projectAt, projectByName } from '../project/projects.ts'

export function repoOf(cwd: string): string | null {
  return projectAt(cwd)?.name ?? null
}

export function readOnlyBaseProjectPath(
  repo: string | undefined,
  callerCwd: string,
): string | null {
  return ((repo ? projectByName(repo) : null) ?? projectAt(callerCwd))?.path ?? null
}
