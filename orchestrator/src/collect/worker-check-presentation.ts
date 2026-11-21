// concern: recorded worker-check presentation for run result

import type { Database } from 'bun:sqlite'
import {
  uncheckedChecksForGateExecution,
} from '../gate/worker-check-omissions.ts'
import { recordedWorkerCheckResult } from '../gate/worker-check-result.ts'
import { workerCheckVerdictLine } from '../gate/worker-check-verdict.ts'
import { lastWorkerCheckNotRunBlock } from './result-output.ts'

export function presentWorkerCheckResult(
  database: Database,
  run: { result_member_record_id: string; reply_head: string | null; reply_tree: string | null },
  error: (value: string) => void,
): void {
  const { execution, verdict } = recordedWorkerCheckResult(
    database,
    run.result_member_record_id,
    run.reply_head,
    run.reply_tree,
  )
  error(workerCheckVerdictLine(verdict))
  const unchecked = execution ? uncheckedChecksForGateExecution(execution.record_id, database) : []
  const omissions = lastWorkerCheckNotRunBlock(unchecked)
  if (omissions) error(omissions)
}
