// concern: terminal reply HEAD and worker-check contradiction

import type { Database } from 'bun:sqlite'
import { recordedWorkerCheckVerdict } from '../gate/worker-check-result.ts'
import { workerCheckRefusalText } from '../gate/worker-check-verdict.ts'
import { gitContext } from '../git/git-environment.ts'
import { terminalTurnChanged } from './run-terminal-change.ts'

type MeasurementScope = { measure<T>(operation: () => T): T }

export function terminalWorkerCheckRefusal(database: Database, runRecordId: string): string | null {
  const replyHead = (
    database.query('SELECT reply_head FROM run WHERE record_id=?').get(runRecordId) as {
      reply_head: string | null
    } | null
  )?.reply_head
  return workerCheckRefusalText(
    recordedWorkerCheckVerdict(database, runRecordId, replyHead ?? null),
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
    : ((
        input.database.query('SELECT head_commit FROM run WHERE record_id=?').get(input.runId) as {
          head_commit: string | null
        } | null
      )?.head_commit ?? null)
  input.database.query('UPDATE run SET reply_head=? WHERE record_id=?').run(replyHead, input.runId)
  return {
    turnChanged: terminalTurnChanged({
      database: input.database,
      runId: input.runId,
      writingJob: input.writesJob,
      worktreePath: input.worktreePath,
      measurementScope: input.measurementScope,
    }),
    contractRefusal: input.writesJob
      ? terminalWorkerCheckRefusal(input.database, input.runId)
      : null,
  }
}
