// concern: recorded gate evidence for read-only workers

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db } from '../database/db.ts'
import { projectAt } from '../project/projects.ts'
export type RecordedGateCandidate = {
  recordId: string
  projectId: string | null
  headCommit: string | null
  runId: string | null
  exitCode: number | null
  timedOut: boolean | null
  elapsedMs: number | null
  finishedAt: string
  outputTail: string
}

export type SelectedRecordedGateResult = RecordedGateCandidate & {
  uncheckedChecks: readonly { check: string; reason: string }[]
}

type GateExecutionRow = {
  record_id: string
  project_record_id: string | null
  head_commit: string | null
  run_record_id: string | null
  exit_code: number | null
  timed_out: number | null
  elapsed_ms: number | null
  finished_at: string
  output_tail: string | null
  cwd: string | null
}

/** Choose the newest finished gate for the exact project commit under review. */
export function selectRecordedGateResult(
  candidates: readonly RecordedGateCandidate[],
  target: { projectId: string; headCommit: string },
): RecordedGateCandidate | null {
  return candidates
    .filter(
      (candidate) =>
        candidate.projectId === target.projectId && candidate.headCommit === target.headCommit,
    )
    .reduce<RecordedGateCandidate | null>((latest, candidate) => {
      if (!latest) return candidate
      const finishedOrder = candidate.finishedAt.localeCompare(latest.finishedAt)
      return finishedOrder > 0 ||
        (finishedOrder === 0 && candidate.recordId.localeCompare(latest.recordId) > 0)
        ? candidate
        : latest
    }, null)
}

function architectProjectIdsByCwd(
  rows: readonly Pick<GateExecutionRow, 'project_record_id' | 'cwd'>[],
): Map<string, string | null> {
  const cwdProjectIds = new Map<string, string | null>()
  for (const row of rows) {
    if (row.project_record_id !== null || !row.cwd || cwdProjectIds.has(row.cwd)) continue
    cwdProjectIds.set(row.cwd, projectAt(row.cwd)?.recordId ?? null)
  }
  return cwdProjectIds
}

function recordedGateCandidateFromRow(
  row: GateExecutionRow,
  cwdProjectIds: ReadonlyMap<string, string | null>,
): RecordedGateCandidate {
  return {
    recordId: row.record_id,
    projectId: row.project_record_id ?? (row.cwd ? (cwdProjectIds.get(row.cwd) ?? null) : null),
    headCommit: row.head_commit,
    runId: row.run_record_id,
    exitCode: row.exit_code,
    timedOut: row.timed_out === null ? null : row.timed_out === 1,
    elapsedMs: row.elapsed_ms,
    finishedAt: row.finished_at,
    outputTail: row.output_tail ?? '',
  }
}

export function recordedGateResult(runId: string): {
  headCommit: string | null
  result: SelectedRecordedGateResult | null
} {
  const run = db()
    .query('SELECT project_record_id,head_commit FROM run WHERE record_id=?')
    .get(runId) as {
    project_record_id: string | null
    head_commit: string | null
  } | null
  if (!run?.project_record_id || !run.head_commit)
    return { headCommit: run?.head_commit ?? null, result: null }

  const rows = db()
    .query(
      `SELECT g.record_id,r.project_record_id,g.head_commit,g.run_record_id,g.exit_code,g.timed_out,g.elapsed_ms,
              g.finished_at,g.output_tail,g.cwd
       FROM gate_execution g LEFT JOIN run r ON r.record_id=g.run_record_id
       WHERE g.purpose='gate' AND g.finished_at IS NOT NULL`,
    )
    .all() as GateExecutionRow[]
  const cwdProjectIds = architectProjectIdsByCwd(rows)
  const result = selectRecordedGateResult(
    rows.map((row) => recordedGateCandidateFromRow(row, cwdProjectIds)),
    { projectId: run.project_record_id, headCommit: run.head_commit },
  )
  if (!result) return { headCommit: run.head_commit, result: null }
  return {
    headCommit: run.head_commit,
    result: { ...result, uncheckedChecks: uncheckedChecksForGateExecution(result.recordId) },
  }
}

/** Read every persisted omission for one gate execution in presentation order. */
export function uncheckedChecksForGateExecution(
  executionRecordId: string,
  database: Database = db(),
): readonly { check: string; reason: string }[] {
  return database
    .query<{ check: string; reason: string }, [string]>(
      `SELECT check_name AS "check",unchecked_reason AS reason
       FROM check_execution
       WHERE gate_execution_record_id=? AND unchecked_reason IS NOT NULL
       ORDER BY check_name,record_id`,
    )
    .all(executionRecordId)
}

/** Read the newest finished worker-check execution attached to one run. */
export function latestFinishedWorkerCheckExecutionRecordId(
  runRecordId: string,
  database: Database = db(),
): string | null {
  const row = database
    .query<{ record_id: string }, [string]>(
      `SELECT record_id FROM gate_execution
       WHERE run_record_id=? AND purpose='worker-check' AND finished_at IS NOT NULL
       ORDER BY requested_at DESC,record_id DESC LIMIT 1`,
    )
    .get(runRecordId)
  return row?.record_id ?? null
}

export function formatRecordedGateResult(input: ReturnType<typeof recordedGateResult>): string {
  if (!input.result) {
    const commit = input.headCommit ? ` for commit ${input.headCommit}` : ''
    return (
      `No finished gate result is recorded${commit}. ` +
      'The landing gate recorded for this commit and the pre-merge local gate are the proof.'
    )
  }
  const result = input.result
  const unchecked = result.uncheckedChecks.length
    ? [
        'unchecked checks:',
        ...result.uncheckedChecks.map((check) => `- ${check.check} (${check.reason})`),
      ]
    : []
  return [
    `Recorded gate result for commit ${result.headCommit}:`,
    `This result was recorded by the issue coordinator's gate or by ${PLATFORM_SLUG} gate run for that commit.`,
    result.runId === null
      ? `recorded by: ${PLATFORM_SLUG} gate run`
      : `executing run id: ${result.runId}`,
    `exit code: ${result.exitCode ?? 'not recorded'}`,
    `timed out: ${result.timedOut ?? 'not recorded'}`,
    `elapsed ms: ${result.elapsedMs ?? 'not recorded'}`,
    `finished at: ${result.finishedAt}`,
    ...unchecked,
    'output tail:',
    result.outputTail,
  ].join('\n')
}
