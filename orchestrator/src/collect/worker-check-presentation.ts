// concern: recorded worker-check presentation for run result

import type { Database } from 'bun:sqlite'
import {
  latestFinishedWorkerCheckExecution,
  uncheckedChecksForGateExecution,
} from '../gate/worker-check-omissions.ts'
import { recordedWorkerCheckVerdictFromExecution } from '../gate/worker-check-result.ts'
import { workerCheckVerdictLine } from '../gate/worker-check-verdict.ts'
import { lastWorkerCheckNotRunBlock } from './result-output.ts'

export function presentWorkerCheckResult(
  database: Database,
  run: { result_member_record_id: string; reply_head: string | null },
  error: (value: string) => void,
): void {
  const execution = latestFinishedWorkerCheckExecution(run.result_member_record_id, database)
  error(
    workerCheckVerdictLine(
      recordedWorkerCheckVerdictFromExecution(database, execution, run.reply_head),
    ),
  )
  const unchecked = execution ? uncheckedChecksForGateExecution(execution.record_id, database) : []
  const omissions = lastWorkerCheckNotRunBlock(unchecked)
  if (omissions) error(omissions)
}
