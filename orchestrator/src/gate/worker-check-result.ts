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

type FinishedWorkerCheckExecution = {
  record_id: string
  number: number
  head_commit: string | null
  tree_id: string | null
  exit_code: number | null
  timed_out: number | null
  output_tail: string | null
  output_artifact: string | null
}

/** Read the newest finished worker check whose checked content matches the reply. */
function latestFinishedWorkerCheckExecution(
  runRecordId: string,
  replyHead: string | null,
  replyTree: string | null,
  database: Database,
): FinishedWorkerCheckExecution | null {
  if (!replyHead) return null
  const row = database
    .query<FinishedWorkerCheckExecution, [string, string, string | null, string | null]>(
      `SELECT record_id,number,head_commit,tree_id,exit_code,timed_out,output_tail,output_artifact
       FROM gate_execution
       WHERE run_record_id=? AND purpose='worker-check' AND finished_at IS NOT NULL
         AND cancelled_reason IS NULL
         AND (head_commit=? OR (? IS NOT NULL AND tree_id=?))
       ORDER BY requested_at DESC,record_id DESC LIMIT 1`,
    )
    .get(runRecordId, replyHead, replyTree, replyTree)
  return row ?? null
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

function workerCheckCandidate(
  database: Database,
  row: FinishedWorkerCheckExecution | null,
): WorkerCheckCandidate | null {
  if (!row) return null
  const legs = failingLegs(database, row.record_id)
  return {
    number: row.number,
    headCommit: row.head_commit,
    treeId: row.tree_id,
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

export function recordedWorkerCheckResult(
  database: Database,
  runRecordId: string,
  replyHead: string | null,
  replyTree: string | null,
): { execution: FinishedWorkerCheckExecution | null; verdict: WorkerCheckVerdict } {
  const execution = latestFinishedWorkerCheckExecution(runRecordId, replyHead, replyTree, database)
  return {
    execution,
    verdict: decideWorkerCheckVerdict(
      replyHead,
      replyTree,
      workerCheckCandidate(database, execution),
    ),
  }
}
