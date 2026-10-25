// concern: session-liveness
/** Decides owner-process liveness from stored ancestry and supplied process probes. */

import {
  type ProcessIdentity,
  parseStoredAncestorChain,
} from '../resources/session-process-anchoring.ts'

type OwnerProcess = 'dead' | 'live' | 'unknown'
export type ProcessProbeResult = { alive: boolean; startTime: string | null }
export type SessionProcessEvidence = ProcessIdentity & {
  alive: boolean
  observedStartTime: string | null
}

type SessionLivenessFacts = {
  candidates: SessionProcessEvidence[]
  ownerLastSeenAt: number | null
}

export type SessionLivenessEvidence = SessionLivenessFacts &
  (
    | {
        ownerProcess: 'unknown'
        unknownCause: { kind: 'recently-seen'; opensAt: number } | { kind: 'unestablished' }
      }
    | { ownerProcess: Exclude<OwnerProcess, 'unknown'>; unknownCause: null }
  )

export function formatSessionLivenessEvidence(
  evidence: Pick<SessionLivenessEvidence, 'candidates' | 'ownerLastSeenAt'>,
): string {
  const candidates = evidence.candidates.length
    ? evidence.candidates
        .map((candidate) => {
          const process = `pid ${candidate.pid} started ${candidate.startTime}`
          if (!candidate.alive) return `${process} gone`
          if (candidate.observedStartTime === null) return `${process} alive (start unreadable)`
          if (candidate.observedStartTime === candidate.startTime) return `${process} alive`
          return `${process} reused (now started ${candidate.observedStartTime})`
        })
        .join('; ')
    : 'process candidates unknown'
  const seen =
    evidence.ownerLastSeenAt === null
      ? 'last_seen unknown'
      : `last_seen ${new Date(evidence.ownerLastSeenAt).toISOString()}`
  return `${candidates}; ${seen}`
}

export function storedSessionCandidates(input: {
  ownerSessionId: string
  ownerAncestorChain: string | null
  actorSessionId: string | null
  actorAncestorChain: string | null
}): { candidates: ProcessIdentity[]; malformed: boolean } {
  const owner = parseStoredAncestorChain(input.ownerSessionId, input.ownerAncestorChain)
  const actor = input.actorSessionId
    ? parseStoredAncestorChain(input.actorSessionId, input.actorAncestorChain)
    : { chain: null, error: null }
  if (owner.error || actor.error) return { candidates: [], malformed: true }
  const shared = new Set((actor.chain ?? []).map(({ pid, startTime }) => `${pid}\0${startTime}`))
  return {
    candidates: (owner.chain ?? []).filter(
      ({ pid, startTime }) => pid !== 1 && !shared.has(`${pid}\0${startTime}`),
    ),
    malformed: false,
  }
}

export function sessionLivenessDecision(input: {
  ownerSessionId: string
  ownerSeen: { ancestorChain: string | null; lastSeenAt: number | null } | null
  actorSessionId: string | null
  actorAncestorChain: string | null
  now: number
  liveWindowMs: number
  probes: SessionProcessEvidence[]
}): SessionLivenessEvidence {
  const ownerLastSeenAt = input.ownerSeen?.lastSeenAt ?? null
  if (!input.ownerSeen)
    return {
      ownerProcess: 'unknown',
      unknownCause: { kind: 'unestablished' },
      candidates: [],
      ownerLastSeenAt,
    }
  const stored = storedSessionCandidates({
    ownerSessionId: input.ownerSessionId,
    ownerAncestorChain: input.ownerSeen.ancestorChain,
    actorSessionId: input.actorSessionId,
    actorAncestorChain: input.actorAncestorChain,
  })
  if (stored.malformed || !stored.candidates.length)
    return {
      ownerProcess: 'unknown',
      unknownCause: { kind: 'unestablished' },
      candidates: [],
      ownerLastSeenAt,
    }
  const candidates = stored.candidates.flatMap((identity) => {
    const probe = input.probes.find(
      ({ pid, startTime }) => pid === identity.pid && startTime === identity.startTime,
    )
    return probe ? [probe] : []
  })
  if (candidates.length !== stored.candidates.length)
    return {
      ownerProcess: 'unknown',
      unknownCause: { kind: 'unestablished' },
      candidates,
      ownerLastSeenAt,
    }
  if (
    candidates.some(
      ({ alive, startTime, observedStartTime }) => alive && observedStartTime === startTime,
    )
  )
    return { ownerProcess: 'live', unknownCause: null, candidates, ownerLastSeenAt }
  if (candidates.some(({ alive, observedStartTime }) => alive && observedStartTime === null))
    return {
      ownerProcess: 'unknown',
      unknownCause: { kind: 'unestablished' },
      candidates,
      ownerLastSeenAt,
    }
  if (ownerLastSeenAt !== null && ownerLastSeenAt >= input.now - input.liveWindowMs)
    return {
      ownerProcess: 'unknown',
      unknownCause: {
        kind: 'recently-seen',
        opensAt: ownerLastSeenAt + input.liveWindowMs + 1,
      },
      candidates,
      ownerLastSeenAt,
    }
  return { ownerProcess: 'dead', unknownCause: null, candidates, ownerLastSeenAt }
}
