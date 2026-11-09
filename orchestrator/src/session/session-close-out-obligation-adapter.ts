// concern: session close-out obligations
/** Reads persisted landing and task facts, then delegates close-out obligation decisions. */

import type { Database } from 'bun:sqlite'
import { readBranchLandingTaskRows } from '../branch/branch-landing-records.ts'
import { observeLandedTasks } from '../branch/task-status-observation.ts'
import { pendingForSession } from '../evidence/evidence-query.ts'
import { projects } from '../project/projects.ts'
import type { SessionOwnedRun } from './session-close-out-decision.ts'
import {
  landedTaskIdentities,
  sessionCloseOutObligations,
} from './session-close-out-obligations.ts'
import type { SessionProcessLine } from './session-close-out-report.ts'

export async function sessionCloseOutObligationItems(
  database: Database,
  session: string,
  ownedRuns: readonly SessionOwnedRun[],
): Promise<SessionProcessLine[]> {
  const ownedRunRecordIds = ownedRuns.map((run) => run.recordId)
  const identities = landedTaskIdentities({
    session,
    ownedRunRecordIds: new Set(ownedRunRecordIds),
    rows: readBranchLandingTaskRows(database),
    keyPrefixesByProject: new Map(
      projects(undefined, database).map((project) => [
        project.name,
        project.settings.keyPrefixes ?? [],
      ]),
    ),
  })
  return sessionCloseOutObligations({
    pendingScores: pendingForSession(session, database),
    landedTasks: await observeLandedTasks(identities),
  })
}
