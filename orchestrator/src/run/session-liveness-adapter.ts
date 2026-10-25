// concern: session-liveness adapter
/** Gathers stored ancestry and probes the owning process for the pure liveness decision. */

import type { Database } from 'bun:sqlite'
import { pidAlive, processStartTime } from '../../../shared/process-identity.ts'
import { SESSION_LIVE_MS } from '../database/db.ts'
import {
  type ProcessProbeResult,
  type SessionLivenessEvidence,
  sessionLivenessDecision,
  storedSessionAnchor,
} from './session-liveness.ts'

export type SessionProcessProbe = (pid: number) => ProcessProbeResult

const processProbe: SessionProcessProbe = (pid) => {
  const alive = pidAlive(pid)
  return { alive, startTime: alive ? processStartTime(pid) : null }
}

type SeenRow = { last_seen: string; ancestor_chain: string | null }

export function sessionLivenessEvidence(
  database: Database,
  ownerSessionId: string,
  actorSessionId: string | null,
  input: {
    now?: number
    liveWindowMs?: number
    probe?: SessionProcessProbe
  } = {},
): SessionLivenessEvidence {
  const ownerSeen = database
    .query<SeenRow, [string]>(
      'SELECT last_seen,ancestor_chain FROM session_seen WHERE session_id=?',
    )
    .get(ownerSessionId)
  const actorSeen = actorSessionId
    ? database
        .query<{ ancestor_chain: string | null }, [string]>(
          'SELECT ancestor_chain FROM session_seen WHERE session_id=?',
        )
        .get(actorSessionId)
    : null
  const anchor = ownerSeen
    ? storedSessionAnchor(ownerSessionId, ownerSeen.ancestor_chain).anchor
    : null
  return sessionLivenessDecision({
    ownerSessionId,
    ownerSeen: ownerSeen
      ? {
          ancestorChain: ownerSeen.ancestor_chain,
          lastSeenAt: Date.parse(ownerSeen.last_seen),
        }
      : null,
    actorSessionId,
    actorAncestorChain: actorSeen?.ancestor_chain ?? null,
    now: input.now ?? Date.now(),
    liveWindowMs: input.liveWindowMs ?? SESSION_LIVE_MS,
    probe: anchor ? (input.probe ?? processProbe)(anchor.pid) : null,
  })
}
