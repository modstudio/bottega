// concern: pending-score-sql
/** Owns the one SQL definition of a conversation that still needs a verdict. */

import { PROVIDER_UNSERVED_SQL } from '../failure/failure.ts'
import { TERMINAL_RUN_STATUS_SQL } from '../run/run-status.ts'

function unscoredWhere(exclusion: string): string {
  return `r.status IN ${TERMINAL_RUN_STATUS_SQL}
   AND COALESCE(r.failure_kind, '') NOT IN (${PROVIDER_UNSERVED_SQL})
   AND ${exclusion} AND COALESCE(r.probe, 0) = 0 AND r.parent_run_record_id IS NULL
   AND COALESCE((SELECT c.status FROM run c WHERE c.parent_run_record_id = r.record_id
                  ORDER BY c.turn DESC LIMIT 1), r.status) <> 'running'
   AND (s.delivery IS NULL
        OR s.scored_at < (SELECT MAX(COALESCE(c.started_at, ''))
                            FROM run c WHERE c.parent_run_record_id = r.record_id
                              AND COALESCE(c.failure_kind, '') NOT IN (${PROVIDER_UNSERVED_SQL})))`
}

export const UNSCORED_WHERE = unscoredWhere('r.evidence_excluded IS NULL')
export const PENDING_SCORE_WHERE = UNSCORED_WHERE
