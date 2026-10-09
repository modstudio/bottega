import type { Audience } from './board-policy.ts'

export const BOARD_NOTE_FILING_LEASE_MS = 2 * 60 * 1_000

export type BoardThreadState = 'open' | 'accepted' | 'withdrawn' | 'expired'

export function boardThreadState(input: {
  acceptedReplyId: string | number | null
  withdrawnAt: string | null
  expiresAt: string | null
  clock: number
}): BoardThreadState {
  if (input.acceptedReplyId !== null) return 'accepted'
  if (input.withdrawnAt !== null) return 'withdrawn'
  if (input.expiresAt !== null && Date.parse(input.expiresAt) <= input.clock) return 'expired'
  return 'open'
}

export type NoteFilingLeaseDecision =
  | { kind: 'take' }
  | { kind: 'filed'; noteId: string }
  | { kind: 'in-progress'; retryAt: number }

export function noteFilingLeaseDecision(
  noteId: string | null,
  filingStartedAt: string | null,
  clock: number,
): NoteFilingLeaseDecision {
  if (noteId !== null) return { kind: 'filed', noteId }
  if (filingStartedAt === null) return { kind: 'take' }
  const retryAt = Date.parse(filingStartedAt) + BOARD_NOTE_FILING_LEASE_MS
  return retryAt <= clock ? { kind: 'take' } : { kind: 'in-progress', retryAt }
}

export type ThreadActor =
  | { kind: 'operator'; reader: string }
  | { kind: 'architect'; reader: string }

export type ThreadRootFacts = {
  id: string | number
  kind: string
  authorReader: string
  audienceKind: Audience['kind']
  live: boolean
  accepted: boolean
}

export function replyRefusal(input: {
  actor: ThreadActor
  root: ThreadRootFacts
  addressed: boolean
  hasReceipt: boolean
}): string | null {
  const { actor, root } = input
  if (root.kind === 'suggestion')
    return `board message ${root.id} is a suggestion; reply only to a notice or question`
  if (root.kind !== 'notice' && root.kind !== 'question')
    return `board message ${root.id} is not a thread root; reply to its root instead`
  if (!root.live) return `board thread ${root.id} is not live; start a new question`
  if (root.kind === 'question' && root.accepted)
    return `board question ${root.id} already has an accepted answer; ask a new question`
  const privileged = actor.kind === 'operator' || actor.reader === root.authorReader
  if ((root.audienceKind === 'architects' || root.audienceKind === 'machine') && !privileged)
    return `board thread ${root.id} is a broadcast; acknowledge it instead of replying`
  if (!privileged && !input.addressed && !input.hasReceipt)
    return `board thread ${root.id} is not addressed to this session and it holds no receipt`
  return null
}

export function acceptRefusal(input: {
  actor: ThreadActor
  questionId: string | number
  questionKind: string
  authorReader: string
  accepted: boolean
  live: boolean
}): string | null {
  if (input.questionKind !== 'question')
    return `board message ${input.questionId} is not a question; accept an answer only on a question`
  if (input.accepted)
    return `board question ${input.questionId} already has an accepted answer; acceptance is final`
  if (!input.live)
    return `board question ${input.questionId} is not open; accept an answer to a live question`
  if (input.actor.kind !== 'operator' && input.actor.reader !== input.authorReader)
    return `only the question author or operator may accept an answer to board question ${input.questionId}`
  return null
}

export function threadParticipants(
  rootAuthor: string,
  replyAuthors: string[],
  replier: string,
): string[] {
  return [...new Set([rootAuthor, ...replyAuthors])].filter((reader) => reader !== replier)
}
