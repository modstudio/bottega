// concern: focused-test-service
/** Loads run context and applies eligibility policy for focused-test requests. */

import { authenticatedWorkerRun } from '../ask/worker-auth.ts'
import { db } from '../database/db.ts'
import { JOBS } from '../jobs/jobs.ts'
import {
  decideFocusedTestEligibility,
  declaredFocusedTestCommands,
  type FocusedTestEligibility,
} from './focused-test-decision.ts'

export function focusedTestEligibility(
  runId: string,
  token: string,
  affected: boolean,
): FocusedTestEligibility {
  const row = db()
    .query(
      `SELECT r.job,p.settings FROM run r
       LEFT JOIN project p ON p.record_id=r.project_record_id WHERE r.record_id=?`,
    )
    .get(runId) as { job: string; settings: string | null } | null
  return decideFocusedTestEligibility({
    authenticated: authenticatedWorkerRun(runId, token),
    writer: Boolean(row && JOBS[row.job]?.needs.writesRepo),
    ...declaredFocusedTestCommands(row?.settings ?? null),
    affected,
  })
}
