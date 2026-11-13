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
    '../doc/context-brief.ts',
    '../doc/context-census-adapter.ts',
    '../doc/context-census.ts',
    '../doc/context-service.ts',
    '../doc/context-stale-adapter.ts',
    '../doc/context-worked-adapter.ts',
    '../doc/doc-context-write.ts',
    '../session/brief-injection.ts',
    '../workflow/session-context.ts',
    './support.ts',
  ]),
  module('orchestrator/src/session/brief-injection.ts', [
    'bun:sqlite',
    '../../../shared/record/schema.ts',
    '../../../shared/record-id.ts',
    '../database/db.ts',
    '../record/machine-identity.ts',
    '../record/outbox-enqueue.ts',
    '../record/outbox-sanitize.ts',
    './session-start-context-limit.ts',
  ]),
  module('orchestrator/src/session/session-start-context-limit.ts', [
    '../../hooks/session-start-context.json',
  ]),
  module('orchestrator/src/workflow/session-context.ts', [
    'bun:sqlite',
    '../../../shared/brand.ts',
    '../../../shared/config-client.ts',
    '../../../shared/config-directory.ts',
    '../../../shared/state-directory.ts',
    '../project/projects.ts',
    './autonomy.ts',
    './autonomy-scopes.ts',
    './session-context-cache.ts',
    './step-catalogue.ts',
  ]),
]
