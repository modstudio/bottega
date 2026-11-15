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
  module('orchestrator/src/record/record-question-contract.ts', ['zod']),
  module('orchestrator/src/record/record-api-client-question.ts', [
    './record-api-client-paths.ts',
    './record-question-contract.ts',
  ]),
  module('orchestrator/src/record/record-api-question.ts', [
    'hono',
    './record-auth.ts',
    './record-question-contract.ts',
  ]),
  module('orchestrator/src/record/record-question-read.ts', [
    'bun',
    '../../../shared/record/tenant.ts',
    './record-pool.ts',
    './record-question-contract.ts',
  ]),
  module('orchestrator/src/record/record-question-write.ts', [
    'bun',
    'drizzle-orm',
    'drizzle-orm/bun-sql',
    '../../../shared/record/hosted-task-id.ts',
    '../../../shared/record/tenant.ts',
    '../../../shared/record/schema-question.ts',
    './record-pool.ts',
    './record-question-audit.ts',
    './record-question-contract.ts',
    './record-sync-project-identity.ts',
    './record-sync-service.ts',
  ]),
  module('orchestrator/src/question-store/question-store.ts', [
    'bun:sqlite',
    '../../../shared/brand.ts',
    '../record/record-api-client-question.ts',
    '../record/record-question-contract.ts',
    '../record/record-sync.ts',
    './question-store-record.ts',
    './question-store-sqlite.ts',
    './question-store-types.ts',
  ]),
  module('orchestrator/src/question-store/question-store-sqlite.ts', [
    'bun:sqlite',
    '../record/record-question-contract.ts',
    '../run/run-inbox.ts',
    '../workflow/task-flow-store-sqlite-questions.ts',
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
    '../run/run-inbox.ts',
    '../workflow/task-flow-store-types.ts',
  ]),
]
