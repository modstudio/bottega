// concern: recorded project gate lookup
/** Answers whether one project commit has an exact passing gate record. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db } from '../database/db.ts'
import { projectAt } from '../project/projects.ts'

type GateCandidate = {
  recordId: string
  number: number
  projectId: string | null
  cwd: string | null
}

export function selectPassingGateNumber(
  candidates: readonly GateCandidate[],
  projectId: string,
  architectProjectId: (cwd: string) => string | null,
): number | null {
  for (const candidate of candidates) {
    const candidateProject =
      candidate.projectId ?? (candidate.cwd ? architectProjectId(candidate.cwd) : null)
    if (candidateProject === projectId) return candidate.number
  }
  return null
}

export function passingGateForCommit(
  commit: string,
  cwd = process.cwd(),
  d: Database = db(),
): { project: string; commit: string; gateNumber: number | null } {
  const project = projectAt(cwd, d)
  if (!project)
    throw new Error(`${PLATFORM_SLUG} gate passed: no registered project contains ${cwd}`)
  const normalized = commit.trim()
  if (!normalized) throw new Error(`${PLATFORM_SLUG} gate passed requires a commit`)
  const candidates = d
    .query<GateCandidate, [string]>(
      `SELECT g.record_id recordId,g.number,r.project_record_id AS projectId,g.cwd
         FROM gate_execution g LEFT JOIN run r ON r.record_id=g.run_record_id
        WHERE g.head_commit=? AND g.finished_at IS NOT NULL AND g.exit_code=0 AND g.timed_out=0
        ORDER BY g.finished_at DESC,g.record_id DESC`,
    )
    .all(normalized)
  return {
    project: project.name,
    commit: normalized,
    gateNumber: selectPassingGateNumber(
      candidates,
      project.recordId,
      (gateCwd) => projectAt(gateCwd, d)?.recordId ?? null,
    ),
  }
}

export function formatPassingGate(result: ReturnType<typeof passingGateForCommit>): string {
  return result.gateNumber === null
    ? `no passing gate recorded for ${result.project} commit ${result.commit}`
    : `passing gate ${result.gateNumber} recorded for ${result.project} commit ${result.commit}`
}
