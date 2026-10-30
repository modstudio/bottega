// concern: resume handoff selection adapter
/** Gathers close-out facts and selects the root runs a resume-brief author still owes. */

import type { Database } from 'bun:sqlite'
import { PENDING_SCORE_WHERE } from '../evidence/evidence-query.ts'
import { branchFacts, heldRunResources, ownedRuns } from './session-close-out.ts'
import { resumeHandoffRootIsOwed } from './session-close-out-decision.ts'

function pendingScoreRootIds(database: Database, rootIds: readonly string[]): Set<string> {
  if (!rootIds.length) return new Set()
  const placeholders = rootIds.map(() => '?').join(',')
  const rows = database
    .query<{ record_id: string }, string[]>(
      `SELECT r.record_id FROM run r LEFT JOIN score s ON s.run_record_id=r.record_id
       WHERE r.record_id IN (${placeholders}) AND ${PENDING_SCORE_WHERE}`,
    )
    .all(...rootIds)
  return new Set(rows.map((row) => row.record_id))
}

export function resumeHandoffOwedRootIds(database: Database, session: string): string[] {
  const runs = ownedRuns(database, session)
  const rootIds = [...new Set(runs.map((run) => run.rootRecordId))]
  const pendingScores = pendingScoreRootIds(database, rootIds)
  const branches = branchFacts(runs, true).branches
  const held = heldRunResources(database, runs).resources
  const membersByRoot = Map.groupBy(runs, (run) => run.rootRecordId)
  return rootIds.filter((rootId) => {
    const members = membersByRoot.get(rootId) ?? []
    const rootBranches = branches.filter((branch) =>
      members.some(
        (member) => member.project === branch.project && member.mintedBranch === branch.branch,
      ),
    )
    return resumeHandoffRootIsOwed({
      runs: members,
      pendingScore: pendingScores.has(rootId),
      branches: rootBranches,
      heldRunResources: held.find((resource) => resource.rootRecordId === rootId),
    })
  })
}
