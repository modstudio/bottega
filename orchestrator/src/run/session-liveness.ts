// concern: session-liveness
/** Decides owner-process liveness from stored ancestry and one supplied process probe. */

import {
  type ProcessIdentity,
  parseStoredAncestorChain,
} from '../resources/session-process-anchoring.ts'

type OwnerProcess = 'dead' | 'live' | 'unknown'
export type ProcessProbeResult = { alive: boolean; startTime: string | null }

export type SessionLivenessEvidence = {
  ownerProcess: OwnerProcess
  anchor: ProcessIdentity | null
  ownerLastSeenAt: number | null
}

export function storedSessionAnchor(
  sessionId: string,
  storedChain: string | null,
): { anchor: ProcessIdentity | null; malformed: boolean } {
  const parsed = parseStoredAncestorChain(sessionId, storedChain)
  return {
    anchor: parsed.chain?.find(({ pid }) => pid !== 1) ?? null,
    malformed: parsed.error !== null,
  }
}

export function sessionLivenessDecision(input: {
  ownerSessionId: string
  ownerSeen: { ancestorChain: string | null; lastSeenAt: number | null } | null
  actorSessionId: string | null
  actorAncestorChain: string | null
  now: number
  liveWindowMs: number
  probe: ProcessProbeResult | null
}): SessionLivenessEvidence {
  const ownerLastSeenAt = input.ownerSeen?.lastSeenAt ?? null
  if (!input.ownerSeen) return { ownerProcess: 'unknown', anchor: null, ownerLastSeenAt }
  const owner = storedSessionAnchor(input.ownerSessionId, input.ownerSeen.ancestorChain)
  if (owner.malformed || !owner.anchor)
    return { ownerProcess: 'unknown', anchor: owner.anchor, ownerLastSeenAt }
  if (input.actorSessionId) {
    const actor = parseStoredAncestorChain(input.actorSessionId, input.actorAncestorChain)
    if (actor.error) return { ownerProcess: 'unknown', anchor: owner.anchor, ownerLastSeenAt }
    if (
      actor.chain?.some(
        ({ pid, startTime }) => pid === owner.anchor!.pid && startTime === owner.anchor!.startTime,
      )
    )
      return { ownerProcess: 'unknown', anchor: owner.anchor, ownerLastSeenAt }
  }
  if (!input.probe) return { ownerProcess: 'unknown', anchor: owner.anchor, ownerLastSeenAt }
  if (input.probe.alive && input.probe.startTime === null)
    return { ownerProcess: 'unknown', anchor: owner.anchor, ownerLastSeenAt }
  if (input.probe.alive && input.probe.startTime === owner.anchor.startTime)
    return { ownerProcess: 'live', anchor: owner.anchor, ownerLastSeenAt }
  const ownerRecentlySeen =
    ownerLastSeenAt !== null && ownerLastSeenAt >= input.now - input.liveWindowMs
  return {
    ownerProcess: ownerRecentlySeen ? 'unknown' : 'dead',
    anchor: owner.anchor,
    ownerLastSeenAt,
  }
}
