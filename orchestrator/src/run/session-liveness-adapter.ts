// concern: session-liveness adapter
/** Gathers stored ancestry and probes the owning process for the pure liveness decision. */

import type { Database } from 'bun:sqlite'
import { pidAlive, processStartTime } from '../../../shared/process-identity.ts'
import { SESSION_LIVE_MS } from '../database/db.ts'
import {
  formatSessionLivenessEvidence,
  type ProcessProbeResult,
  type SessionLivenessEvidence,
  type SessionProcessEvidence,
  sessionLivenessDecision,
  storedSessionCandidates,
} from './session-liveness.ts'

export { formatSessionLivenessEvidence, type SessionProcessEvidence }

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
  const candidates = ownerSeen
    ? storedSessionCandidates({
        ownerSessionId,
        ownerAncestorChain: ownerSeen.ancestor_chain,
        actorSessionId,
        actorAncestorChain: actorSeen?.ancestor_chain ?? null,
      }).candidates
    : []
  const probe = input.probe ?? processProbe
  const observedByPid = new Map<number, ProcessProbeResult>()
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
    probes: candidates.map((identity) => {
      let observed = observedByPid.get(identity.pid)
      if (!observed) {
        observed = probe(identity.pid)
        observedByPid.set(identity.pid, observed)
      }
      return { ...identity, alive: observed.alive, observedStartTime: observed.startTime }
    }),
  })
}
