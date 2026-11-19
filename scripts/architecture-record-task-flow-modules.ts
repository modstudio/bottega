// concern: architecture-manifest
/** Hosted task-flow read and client module allowlists. */
import { dirname, normalize } from 'node:path'

type RecordModule = { file: string; allowed: string[] }
const module = (file: string, allowed: string[]): RecordModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const recordTaskFlowModules: RecordModule[] = [
  module('orchestrator/src/record/record-task-flow-contract.ts', ['zod', './record-cursor.ts']),
  module('orchestrator/src/record/record-task-flow-list-query.ts', [
    './record-cursor.ts',
    './record-task-flow-contract.ts',
  ]),
  module('orchestrator/src/record/record-task-flow.ts', [
    '../../../shared/record-timestamp.ts',
    '../../../shared/record/tenant.ts',
    './record-pool.ts',
    './record-question-read.ts',
    './record-task-flow-contract.ts',
    './record-task-flow-list-query.ts',
  ]),
  module('orchestrator/src/record/record-api-client-task-flow.ts', [
    '../doc/doc-revision-conflict.ts',
    './record-auth.ts',
    './record-api-client-response.ts',
    './record-api-client-paths.ts',
    './record-task-flow-contract.ts',
    './record-task-flow-write-contract.ts',
  ]),
  module('orchestrator/src/record/record-history-upload.ts', [
    'bun:sqlite',
    'node:fs',
    'node:path',
    '../../../shared/brand.ts',
    '../../../shared/record-id.ts',
    '../../../shared/state-directory.ts',
    '../database/db.ts',
    '../project/project-relink.ts',
    '../question-store/question-store-mutation.ts',
    '../question-store/question-store.ts',
    '../workflow/task-flow-store.ts',
    './install-binding.ts',
    './record-api-client.ts',
    './record-api-client-paths.ts',
    './record-hosted-row-presence.ts',
    './record-write-destination.ts',
    './record-task-flow-write-contract.ts',
  ]),
  module('orchestrator/src/record/record-hosted-row-presence.ts', [
    'bun:sqlite',
    './record-task-flow-contract.ts',
  ]),
]
