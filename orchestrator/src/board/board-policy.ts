export const BOARD_DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000
export const BOARD_DEFAULT_ACK_DEADLINE_MS = 60 * 60 * 1000
export const BOARD_POST_RATE_LIMIT = 10
export const BOARD_POST_RATE_WINDOW_MS = 10 * 60 * 1000
export const BOARD_DUPLICATE_WINDOW_MS = 10 * 60 * 1000
const BOARD_RETENTION_MS = 14 * 24 * 60 * 60 * 1000

/** The local operator has no session id; this reserved reader keeps receipts non-null. */
export const OPERATOR_READER = 'operator'

export type ArchitectIdentity = { session: string; harness: 'claude-code' }
const ARCHITECT_IDENTITIES = [
  { environment: 'CLAUDE_CODE_SESSION_ID', harness: 'claude-code' as const },
] as const

export function architectIdentity(
  env: Record<string, string | undefined>,
): ArchitectIdentity | null {
  for (const entry of ARCHITECT_IDENTITIES) {
    const session = env[entry.environment]?.trim()
    if (session && session !== OPERATOR_READER) return { session, harness: entry.harness }
  }
  return null
}

export type PresenceFact = { session: string; project: string; lastSeen: number }
export type Audience =
  | { kind: 'operator' }
  | { kind: 'architects' }
  | { kind: 'project'; value: string }
  | { kind: 'session'; value: string }

export function parseAudience(expression: string): Audience {
  if (expression === 'operator') return { kind: 'operator' }
  if (expression === 'architects') return { kind: 'architects' }
  const match = /^(project|session):(.+)$/.exec(expression)
  if (!match?.[2]?.trim()) throw new Error(`unsupported board audience ${expression}`)
  if (match[1] === 'session' && match[2] === OPERATOR_READER)
    throw new Error(`session:${OPERATOR_READER} is reserved; use audience operator`)
  return { kind: match[1] as 'project' | 'session', value: match[2] }
}

export function audienceRefusal(
  audience: Audience,
  author: 'operator' | 'architect',
): string | null {
  return audience.kind === 'architects' && author !== 'operator'
    ? 'only the operator may address architects; use project:<name>'
    : null
}

export function resolveAudience(
  audience: Audience,
  presence: PresenceFact[],
  now: number,
  liveWindowMs: number,
): string[] {
  if (audience.kind === 'operator') return [OPERATOR_READER]
  const live = presence.filter((row) => now - row.lastSeen <= liveWindowMs && row.lastSeen <= now)
  if (audience.kind === 'architects') return live.map((row) => row.session)
  if (audience.kind === 'project')
    return live.filter((row) => row.project === audience.value).map((row) => row.session)
  return live.filter((row) => row.session === audience.value).map((row) => row.session)
}

export const shouldInterrupt = (message: { authorKind: string; ackRequired: boolean }): boolean =>
  message.authorKind === 'operator' && message.ackRequired

export const messageIsLive = (
  message: { expiresAt: number; withdrawnAt: number | null },
  now: number,
) => message.withdrawnAt === null && message.expiresAt > now

export const messageCanBeReaped = (
  message: { expiresAt: number; withdrawnAt: number | null },
  now: number,
) => now >= (message.withdrawnAt ?? message.expiresAt) + BOARD_RETENTION_MS

export function postDecision(input: {
  recentPosts: number
  duplicate: boolean
}): 'post' | 'drop-duplicate' | 'rate-limited' {
  if (input.duplicate) return 'drop-duplicate'
  return input.recentPosts >= BOARD_POST_RATE_LIMIT ? 'rate-limited' : 'post'
}

export const needsAckEscalation = (input: {
  ackRequired: boolean
  deadline: number | null
  acknowledgedAt: number | null
  audienceMemberLastSeen: number | null
  createdAt: number
  now: number
}) =>
  input.ackRequired &&
  input.deadline !== null &&
  input.deadline <= input.now &&
  input.acknowledgedAt === null &&
  (input.audienceMemberLastSeen === null || input.audienceMemberLastSeen <= input.createdAt)
