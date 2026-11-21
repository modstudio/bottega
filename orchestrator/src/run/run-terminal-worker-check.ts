// concern: terminal reply HEAD and worker-check contradiction

import type { Database } from 'bun:sqlite'
import { recordedWorkerCheckResult } from '../gate/worker-check-result.ts'
import { workerCheckRefusalText } from '../gate/worker-check-verdict.ts'
import { gitContext } from '../git/git-environment.ts'
import { terminalTurnChanged } from './run-terminal-change.ts'

type MeasurementScope = { measure<T>(operation: () => T): T }

export function terminalWorkerCheckRefusal(
  database: Database,
  runRecordId: string,
  replyHead: string | null,
  replyTree: string | null,
): string | null {
  return workerCheckRefusalText(
    recordedWorkerCheckResult(database, runRecordId, replyHead, replyTree).verdict,
  )
}

export function terminalReplyFacts(input: {
  database: Database
  runId: string
  writesJob: boolean
  worktreePath: string | null
  measurementScope: MeasurementScope | null
}): { turnChanged: boolean | null; contractRefusal: string | null } {
  const replyHead = input.worktreePath
    ? gitContext(input.worktreePath, 'rev-parse', '--verify', 'HEAD^{commit}')
    : null
  const replyTree =
    input.worktreePath && replyHead
      ? gitContext(input.worktreePath, 'rev-parse', '--verify', `${replyHead}^{tree}`)
      : null
  input.database
    .query('UPDATE run SET reply_head=?,reply_tree=? WHERE record_id=?')
    .run(replyHead, replyTree, input.runId)
  return {
    turnChanged: terminalTurnChanged({
      database: input.database,
      runId: input.runId,
      writingJob: input.writesJob,
      worktreePath: input.worktreePath,
      measurementScope: input.measurementScope,
    }),
    contractRefusal: input.writesJob
      ? terminalWorkerCheckRefusal(input.database, input.runId, replyHead, replyTree)
      : null,
  }
}
