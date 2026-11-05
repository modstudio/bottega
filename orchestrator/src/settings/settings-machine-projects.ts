// concern: settings-machine-projects
/** Filesystem and Git facts for project-scoped Claude MCP registration. */
import { existsSync } from 'node:fs'
import { mainCheckoutOf, resolvedPathsEqual } from '../../../shared/git.ts'
import type { RegisteredProjectScopeFact } from './settings-machine-scope.ts'

export function registeredProjectScopeFact(path: string): RegisteredProjectScopeFact {
  if (!existsSync(path)) return { path, exists: false, gitMainCheckout: false }
  return {
    path,
    exists: true,
    gitMainCheckout: resolvedPathsEqual(mainCheckoutOf(path) ?? '', path),
  }
}
