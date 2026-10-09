// concern: recorded project gate lookup
/** Answers whether one project commit has an exact passing gate record. */

import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import { projectAt } from '../project/projects.ts'

type GateCandidate = {
  id: number
  projectId: number | null
  cwd: string | null
}

export function selectPassingGateId(
  candidates: readonly GateCandidate[],
  projectId: number,
  architectProjectId: (cwd: string) => number | null,
): number | null {
  for (const candidate of candidates) {
    const candidateProject =
      candidate.projectId ?? (candidate.cwd ? architectProjectId(candidate.cwd) : null)
    if (candidateProject === projectId) return candidate.id
  }
  return null
}

export function passingGateForCommit(
  commit: string,
  cwd = process.cwd(),
  d: Database = db(),
): { project: string; commit: string; gateId: number | null } {
  const project = projectAt(cwd, d)
  if (!project) throw new Error(`orch gate passed: no registered project contains ${cwd}`)
  const normalized = commit.trim()
  if (!normalized) throw new Error('orch gate passed requires a commit')
  const candidates = d
    .query<GateCandidate, [string]>(
      `SELECT g.id,r.project_id AS projectId,g.cwd
         FROM gate_execution g LEFT JOIN run r ON r.id=g.run_id
        WHERE g.head_commit=? AND g.finished_at IS NOT NULL AND g.exit_code=0 AND g.timed_out=0
        ORDER BY g.id DESC`,
    )
    .all(normalized)
  return {
    project: project.name,
    commit: normalized,
    gateId: selectPassingGateId(
      candidates,
      project.id,
      (gateCwd) => projectAt(gateCwd, d)?.id ?? null,
    ),
  }
}

export function formatPassingGate(result: ReturnType<typeof passingGateForCommit>): string {
  return result.gateId === null
    ? `no passing gate recorded for ${result.project} commit ${result.commit}`
    : `passing gate ${result.gateId} recorded for ${result.project} commit ${result.commit}`
}
