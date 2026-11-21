// concern: recorded worker-check evidence at a reply commit

import type { Database } from 'bun:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { UNCHECKED_EXIT_CODE } from '../../../shared/check-execution.ts'
import {
  decideWorkerCheckVerdict,
  type WorkerCheckCandidate,
  type WorkerCheckVerdict,
  workerCheckFailures,
} from './worker-check-verdict.ts'

type WorkerCheckRow = {
  record_id: string
  number: number
  head_commit: string | null
  requested_at: string
  exit_code: number | null
  timed_out: number | null
  output_tail: string | null
  output_artifact: string | null
}

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

/** Read plain candidates for the pure reply-HEAD verdict decision. */
export function workerCheckCandidates(
  database: Database,
  runRecordId: string,
): WorkerCheckCandidate[] {
  return database
    .query<WorkerCheckRow, [string]>(
      `SELECT record_id,number,head_commit,requested_at,exit_code,timed_out,output_tail,output_artifact
       FROM gate_execution
       WHERE run_record_id=? AND purpose='worker-check' AND finished_at IS NOT NULL`,
    )
    .all(runRecordId)
    .map((row) => {
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
    })
}

export function recordedWorkerCheckVerdict(
  database: Database,
  runRecordId: string,
  replyHead: string | null,
): WorkerCheckVerdict {
  return decideWorkerCheckVerdict(replyHead, workerCheckCandidates(database, runRecordId))
}
