// concern: architecture-manifest
/** Session measurement allowlists kept outside the root manifest's file ceiling. */
import { dirname, normalize } from 'node:path'

type SessionReportModule = { file: string; allowed: string[] }
const module = (file: string, allowed: string[]): SessionReportModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const sessionReportModules: SessionReportModule[] = [
  module('orchestrator/src/session-report/session-report.ts', ['../../../shared/brand.ts']),
  module('orchestrator/src/session-report/session-report-adapter.ts', [
    'bun:sqlite',
    '../database/db.ts',
    '../evidence/pending-score-sql.ts',
    '../record/record-write-authority.ts',
    '../run/question-open.ts',
    '../workflow/task-flow-store.ts',
    './session-report.ts',
  ]),
  module('orchestrator/src/session-report/session-report-format.ts', [
    '../commands/support.ts',
    './session-report-adapter.ts',
    './session-report.ts',
  ]),
]
