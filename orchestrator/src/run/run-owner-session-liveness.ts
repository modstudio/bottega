// concern: recorded run owner-session liveness
/** Adapts stored session process identity to the run liveness facts. */

import type { Database } from 'bun:sqlite'
import { sessionId } from '../database/db.ts'
import { type SessionProcessProbe, sessionLivenessEvidence } from './session-liveness-adapter.ts'

export type RecordedOwnerProcess = 'live' | 'dead' | 'unknown' | 'missing'

export function recordedOwnerProcess(
  database: Database,
  ownerSessionId: string | null | undefined,
  now = Date.now(),
  probe?: SessionProcessProbe,
): RecordedOwnerProcess {
  if (!ownerSessionId) return 'missing'
  const actor = sessionId(database)
  const evidence = sessionLivenessEvidence(
    database,
    ownerSessionId,
    actor === ownerSessionId ? null : actor,
    {
      now,
      probe,
    },
  )
  if (evidence.ownerProcess === 'live') return 'live'
  if (evidence.ownerProcess === 'unknown') return 'unknown'
  return evidence.candidates.length ? 'dead' : 'missing'
}
