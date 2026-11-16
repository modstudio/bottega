// concern: architecture-manifest
/** Direct hosted-question and question-store module allowlists. */
import { dirname, normalize } from 'node:path'

type RecordModule = { file: string; allowed: string[] }
const module = (file: string, allowed: string[]): RecordModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const recordQuestionModules: RecordModule[] = [
  module('orchestrator/src/record/record-question-contract.ts', [
    'zod',
    '../../../shared/brand.ts',
    '../../../shared/record/record-changes.ts',
  ]),
  module('orchestrator/src/record/record-api-client-question.ts', [
    './record-api-client-paths.ts',
    './record-question-contract.ts',
  ]),
  module('orchestrator/src/record/record-api-question.ts', [
    'hono',
    '../../../shared/record/record-changes.ts',
    './record-auth.ts',
    './record-question-contract.ts',
  ]),
  module('orchestrator/src/record/record-question-read.ts', [
    'bun',
    '../../../shared/record/record-changes.ts',
    '../../../shared/record/tenant.ts',
    './record-pool.ts',
    './record-question-contract.ts',
  ]),
  module('orchestrator/src/record/record-question-number.ts', ['bun']),
  module('orchestrator/src/record/record-question-write.ts', [
    'drizzle-orm',
    'drizzle-orm/bun-sql',
    '../../../shared/record/hosted-task-id.ts',
    '../../../shared/record/tenant.ts',
    '../../../shared/record/schema-question.ts',
    './record-pool.ts',
    './record-question-audit.ts',
    './record-question-contract.ts',
    './record-question-number.ts',
    './record-sync-project-identity.ts',
    './record-sync-service.ts',
  ]),
  module('orchestrator/src/question-store/question-store.ts', [
    'bun:sqlite',
    './question-store-sqlite.ts',
    './question-store-types.ts',
  ]),
  module('orchestrator/src/question-store/question-store-record-factory.ts', [
    'bun:sqlite',
    '../../../shared/brand.ts',
    '../record/record-api-client-question.ts',
    '../record/record-sync.ts',
    './question-store-record.ts',
    './question-store-types.ts',
  ]),
  module('orchestrator/src/question-store/question-store-sql.ts', []),
  module('orchestrator/src/question-store/question-store-sqlite.ts', [
    'bun:sqlite',
    '../record/record-question-contract.ts',
    '../run/question-outbox.ts',
    './question-store-sqlite-reads.ts',
    './question-store-types.ts',
  ]),
  module('orchestrator/src/question-store/question-store-record.ts', [
    'bun:sqlite',
    '../../../shared/brand.ts',
    '../../../shared/session-liveness.ts',
    '../record/record-api-client-question.ts',
    '../record/record-question-contract.ts',
    './question-store-types.ts',
  ]),
  module('orchestrator/src/question-store/question-store-types.ts', [
    '../record/record-question-contract.ts',
    '../workflow/task-flow-store-types.ts',
    './question-store-sqlite-reads.ts',
  ]),
  module('orchestrator/src/question-store/question-store-mutation.ts', [
    'bun:sqlite',
    '../../../shared/record-id.ts',
    '../record/machine-identity.ts',
    '../record/record-question-contract.ts',
    '../run/question-outbox.ts',
    './question-store.ts',
  ]),
  module('orchestrator/src/question-store/question-store-read.ts', [
    'bun:sqlite',
    '../workflow/task-flow-store-types.ts',
    './question-store.ts',
  ]),
  module('orchestrator/src/question-store/question-store-sqlite-reads.ts', [
    'bun:sqlite',
    '../../../shared/session-liveness.ts',
    '../evidence/evidence-query.ts',
    '../workflow/task-flow-store-types.ts',
    './question-store-sql.ts',
  ]),
  module('orchestrator/src/question-store/question-store-record-task-flow-compat.ts', [
    'bun:sqlite',
    '../../../shared/brand.ts',
    '../record/record-task-flow-contract.ts',
    '../workflow/task-flow-store-record-stage-row.ts',
    '../workflow/task-flow-store-types.ts',
    './question-store-sql.ts',
  ]),
]
