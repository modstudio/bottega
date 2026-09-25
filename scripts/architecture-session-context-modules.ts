// concern: architecture-manifest
/** The architect session-context allowlists, kept beside the root manifest so it stays within its file ceiling. */
import { dirname, normalize } from 'node:path'

type SessionContextModule = { file: string; allowed: string[] }

const module = (file: string, allowed: string[]): SessionContextModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const sessionContextModules: SessionContextModule[] = [
  module('orchestrator/src/commands/context.ts', [
    '../workflow/session-context.ts',
    './support.ts',
  ]),
  module('orchestrator/src/workflow/session-context.ts', [
    '../../../shared/brand.ts',
    '../project/projects.ts',
    './autonomy.ts',
    './autonomy-scopes.ts',
    './step-catalogue.ts',
  ]),
]
