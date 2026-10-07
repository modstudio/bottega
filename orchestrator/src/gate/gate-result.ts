// concern: recorded gate evidence for read-only workers

import { db } from '../database/db.ts'
import { projectAt } from '../project/projects.ts'

export type RecordedGateCandidate = {
  id: number
  projectId: number | null
  headCommit: string | null
  runId: number | null
  exitCode: number | null
  timedOut: boolean | null
  elapsedMs: number | null
  finishedAt: string
  outputTail: string
}

type GateExecutionRow = {
  id: number
  project_id: number | null
  head_commit: string | null
  run_id: number | null
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
  target: { projectId: number; headCommit: string },
): RecordedGateCandidate | null {
  return candidates
    .filter(
      (candidate) =>
        candidate.projectId === target.projectId && candidate.headCommit === target.headCommit,
    )
    .reduce<RecordedGateCandidate | null>((latest, candidate) => {
      if (!latest) return candidate
      const finishedOrder = candidate.finishedAt.localeCompare(latest.finishedAt)
      return finishedOrder > 0 || (finishedOrder === 0 && candidate.id > latest.id)
        ? candidate
        : latest
    }, null)
}

function architectProjectIdsByCwd(
  rows: readonly Pick<GateExecutionRow, 'project_id' | 'cwd'>[],
): Map<string, number | null> {
  const cwdProjectIds = new Map<string, number | null>()
  for (const row of rows) {
    if (row.project_id !== null || !row.cwd || cwdProjectIds.has(row.cwd)) continue
    cwdProjectIds.set(row.cwd, projectAt(row.cwd)?.id ?? null)
  }
  return cwdProjectIds
}

function recordedGateCandidateFromRow(
  row: GateExecutionRow,
  cwdProjectIds: ReadonlyMap<string, number | null>,
): RecordedGateCandidate {
  return {
    id: row.id,
    projectId: row.project_id ?? (row.cwd ? (cwdProjectIds.get(row.cwd) ?? null) : null),
    headCommit: row.head_commit,
    runId: row.run_id,
    exitCode: row.exit_code,
    timedOut: row.timed_out === null ? null : row.timed_out === 1,
    elapsedMs: row.elapsed_ms,
    finishedAt: row.finished_at,
    outputTail: row.output_tail ?? '',
  }
}

export function recordedGateResult(runId: number): {
  headCommit: string | null
  result: RecordedGateCandidate | null
} {
  const run = db().query('SELECT project_id,head_commit FROM run WHERE id=?').get(runId) as {
    project_id: number | null
    head_commit: string | null
  } | null
  if (!run?.project_id || !run.head_commit)
    return { headCommit: run?.head_commit ?? null, result: null }

  const rows = db()
    .query(
      `SELECT g.id,r.project_id,g.head_commit,g.run_id,g.exit_code,g.timed_out,g.elapsed_ms,
              g.finished_at,g.output_tail,g.cwd
       FROM gate_execution g LEFT JOIN run r ON r.id=g.run_id
       WHERE g.finished_at IS NOT NULL`,
    )
    .all() as GateExecutionRow[]
  const cwdProjectIds = architectProjectIdsByCwd(rows)
  return {
    headCommit: run.head_commit,
    result: selectRecordedGateResult(
      rows.map((row) => recordedGateCandidateFromRow(row, cwdProjectIds)),
      { projectId: run.project_id, headCommit: run.head_commit },
    ),
  }
}

export function formatRecordedGateResult(input: ReturnType<typeof recordedGateResult>): string {
  if (!input.result) {
    const commit = input.headCommit ? ` for commit ${input.headCommit}` : ''
    return (
      `No finished gate result is recorded${commit}. ` +
      "The writer's gate and the pre-merge local gate are the proof."
    )
  }
  const result = input.result
  return [
    `Recorded gate result for commit ${result.headCommit}:`,
    "This result was recorded by the project's writer gate or by orch gate run for that commit.",
    result.runId === null ? 'recorded by: orch gate run' : `executing run id: ${result.runId}`,
    `exit code: ${result.exitCode ?? 'not recorded'}`,
    `timed out: ${result.timedOut ?? 'not recorded'}`,
    `elapsed ms: ${result.elapsedMs ?? 'not recorded'}`,
    `finished at: ${result.finishedAt}`,
    'output tail:',
    result.outputTail,
  ].join('\n')
}
