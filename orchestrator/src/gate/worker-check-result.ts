// concern: recorded worker-check evidence at a reply commit

import type { Database } from 'bun:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { UNCHECKED_EXIT_CODE } from '../../../shared/check-execution.ts'
import {
  type FinishedWorkerCheckExecution,
  latestFinishedWorkerCheckExecution,
} from './worker-check-omissions.ts'
import {
  decideWorkerCheckVerdict,
  type WorkerCheckCandidate,
  type WorkerCheckVerdict,
  workerCheckFailures,
} from './worker-check-verdict.ts'

function failingLegs(database: Database, executionRecordId: string): string[] {
  return database
    .query<{ check_name: string }, [string, number]>(
      `SELECT check_name FROM check_execution
       WHERE gate_execution_record_id=? AND exit_code NOT IN (0,?)
       ORDER BY rowid`,
    )
    .all(executionRecordId, UNCHECKED_EXIT_CODE)
    .map((row) => row.check_name)
}

function workerCheckCandidate(
  database: Database,
  row: FinishedWorkerCheckExecution | null,
): WorkerCheckCandidate | null {
  if (!row) return null
  const legs = failingLegs(database, row.record_id)
  return {
    recordId: row.record_id,
    number: row.number,
    headCommit: row.head_commit,
    requestedAt: row.requested_at,
    exitCode: row.exit_code,
    timedOut: row.timed_out === null ? null : row.timed_out === 1,
    failures: workerCheckFailures(
      row.output_artifact && existsSync(row.output_artifact)
        ? readFileSync(row.output_artifact, 'utf8')
        : (row.output_tail ?? ''),
      legs,
    ),
  }
}

export function recordedWorkerCheckVerdictFromExecution(
  database: Database,
  execution: FinishedWorkerCheckExecution | null,
  replyHead: string | null,
): WorkerCheckVerdict {
  return decideWorkerCheckVerdict(replyHead, workerCheckCandidate(database, execution))
}

export function recordedWorkerCheckVerdict(
  database: Database,
  runRecordId: string,
  replyHead: string | null,
): WorkerCheckVerdict {
  return recordedWorkerCheckVerdictFromExecution(
    database,
    latestFinishedWorkerCheckExecution(runRecordId, database),
    replyHead,
  )
}
