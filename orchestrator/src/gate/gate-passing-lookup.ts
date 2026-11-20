// concern: passing gate lookup
/** Selects the newest passing gate for one exact project commit. */

import type { Database } from 'bun:sqlite'

type GateCandidate = {
  recordId: string
  number: number
  projectId: string | null
  cwd: string | null
}

export function selectPassingGateNumber(
  candidates: readonly GateCandidate[],
  projectId: string,
  projectIdForCwd: (cwd: string) => string | null,
): number | null {
  for (const candidate of candidates) {
    const candidateProject =
      candidate.projectId ?? (candidate.cwd ? projectIdForCwd(candidate.cwd) : null)
    if (candidateProject === projectId) return candidate.number
  }
  return null
}

export function passingGateNumberForProjectCommit(
  database: Database,
  commit: string,
  projectId: string,
  projectIdForCwd: (cwd: string) => string | null,
): number | null {
  const candidates = database
    .query<GateCandidate, [string]>(
      `SELECT g.record_id recordId,g.number,r.project_record_id AS projectId,g.cwd
         FROM gate_execution g LEFT JOIN run r ON r.record_id=g.run_record_id
        WHERE g.head_commit=? AND g.purpose='gate' AND g.finished_at IS NOT NULL AND g.exit_code=0 AND g.timed_out=0
        ORDER BY g.finished_at DESC,g.record_id DESC`,
    )
    .all(commit)
  return selectPassingGateNumber(candidates, projectId, projectIdForCwd)
}
