// concern: architecture-manifest
/** The hosted-record command module allowlists, kept beside the root manifest so it stays within its file ceiling. */
import { dirname, normalize } from 'node:path'

type RecordModule = { file: string; allowed: string[] }

const module = (file: string, allowed: string[]): RecordModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const recordModules: RecordModule[] = [
  module('orchestrator/src/run/question-delivery.ts', [
    '../database/db.ts',
    './question-vocabulary.ts',
  ]),
  module('orchestrator/src/run/question-outbox.ts', [
    'bun:sqlite',
    '../../../shared/record/schema.ts',
    '../../../shared/secret-shaped.ts',
    '../database/db.ts',
  ]),
  module('orchestrator/src/record/record-command.ts', [
    '../../../shared/machine-config.ts',
    '../postgres/postgres-migrate.ts',
    '../project/projects.ts',
    './record-doctor.ts',
    './record-space-move.ts',
    './record-space.ts',
    './record-tunnel-error.ts',
  ]),
  module('orchestrator/src/record/record-tunnel-error.ts', []),
  module('orchestrator/src/record/record-attribution.ts', [
    'bun:sqlite',
    '../database/db.ts',
    './record-api-client.ts',
    './record-session.ts',
  ]),
  module('orchestrator/src/record/record-doctor.ts', [
    '../postgres/postgres-migrate.ts',
    '../database/db.ts',
    '../../../shared/record/schema.ts',
    './record-attribution.ts',
    './record-auth.ts',
    './record-session.ts',
    './record-sync.ts',
    './machine-identity.ts',
  ]),
  module('orchestrator/src/record/record-session.ts', [
    '../../../shared/record-session.ts',
    '../../../shared/record-remedies.ts',
    '../database/db.ts',
    './record-auth.ts',
  ]),
  module('orchestrator/src/record/record-space.ts', [
    '../../../shared/record/schema.ts',
    './record-api-client.ts',
    './record-auth.ts',
    './record-session.ts',
  ]),
  module('orchestrator/src/record/record-invitation.ts', []),
  module('orchestrator/src/record/record-space-move.ts', [
    'bun',
    '../postgres/postgres-migrate.ts',
    './record-session.ts',
    './record-space.ts',
  ]),
]
