// concern: architecture-manifest
/** Hosted record API refusal-renderer module allowlists. */
import { dirname, normalize } from 'node:path'

type RecordModule = { file: string; allowed: string[] }
const module = (file: string, allowed: string[]): RecordModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const recordApiErrorModules: RecordModule[] = [
  module('orchestrator/src/record/record-api-errors.ts', [
    '../doc/doc-revision-conflict.ts',
    './outbox-failure.ts',
    './record-board-contract.ts',
    './record-config-error.ts',
    './record-docs.ts',
    './record-projects.ts',
    './record-project-purge-contract.ts',
    './record-project-space-contract.ts',
    './record-question-contract.ts',
    './record-trial-space-contract.ts',
    './record-verdicts.ts',
  ]),
]
