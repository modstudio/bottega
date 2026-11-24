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
    '../../../shared/context-item-vocabulary.ts',
    '../../../shared/record/schema-session.ts',
    '../context-health/context-health-adapter.ts',
    '../context-health/context-health-render.ts',
    '../doc/context-brief.ts',
    '../doc/context-service.ts',
    '../session/brief-injection.ts',
    '../session/context-review.ts',
    '../session/hook-emission.ts',
    '../workflow/session-context.ts',
    './support.ts',
  ]),
  module('orchestrator/src/session/brief-injection.ts', [
    'bun:sqlite',
    '../../../shared/record/schema-session.ts',
    '../../../shared/record-id.ts',
    '../database/db.ts',
    '../record/brief-injection-outbox.ts',
    '../record/machine-identity.ts',
    '../record/outbox-enqueue.ts',
    '../record/outbox-sanitize.ts',
    '../workflow/task-flow-store.ts',
    './keyless-cursor-idle.ts',
    './session-start-context-limit.ts',
  ]),
  module('orchestrator/src/session/context-review-decision.ts', []),
  module('orchestrator/src/session/context-review-store.ts', [
    'bun:sqlite',
    '../../../shared/record-id.ts',
    '../database/db.ts',
    '../record/context-review-outbox.ts',
    '../record/machine-identity.ts',
    '../record/outbox-enqueue.ts',
    '../record/outbox-sanitize.ts',
  ]),
  module('orchestrator/src/session/context-review.ts', [
    'bun:sqlite',
    '../../../shared/brand.ts',
    '../../../shared/context-item-vocabulary.ts',
    '../database/db.ts',
    '../doc/context-brief.ts',
    '../doc/context-cursor-warning-decision.ts',
    '../doc/context-item-store.ts',
    '../doc/doc-subjects.ts',
    '../workflow/project-task-list.ts',
    '../workflow/project-task-lookup.ts',
    '../workflow/workflow-cursor-list.ts',
    '../workflow/workflow-task-reference.ts',
    './context-review-decision.ts',
    './context-review-store.ts',
  ]),
  module('orchestrator/src/session/hook-emission.ts', [
    'bun:sqlite',
    '../../../shared/record/schema-session.ts',
    '../../../shared/record-id.ts',
    '../database/db.ts',
    '../record/hook-emission-outbox.ts',
    '../record/machine-identity.ts',
    '../record/outbox-enqueue.ts',
    '../record/outbox-sanitize.ts',
  ]),
  module('orchestrator/src/session/keyless-cursor-idle.ts', ['../events.ts']),
  module('orchestrator/src/session/keyless-cursor-idle-admission.ts', [
    '../../../shared/brand.ts',
    '../caller-classification.ts',
    '../database/db.ts',
    '../workflow/task-flow-store.ts',
    '../workflow/workflow-cursor-format.ts',
    './keyless-cursor-idle.ts',
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
