import { containsSecretShaped } from '../../../shared/secret-shaped.ts'

export const BOARD_DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000
export const BOARD_DEFAULT_ACK_DEADLINE_MS = 60 * 60 * 1000
export const BOARD_POST_RATE_LIMIT = 10
export const BOARD_POST_RATE_WINDOW_MS = 10 * 60 * 1000
export const BOARD_DUPLICATE_WINDOW_MS = 10 * 60 * 1000
export const BOARD_TITLE_MAX_CHARS = 120
export const BOARD_BODY_MAX_CHARS = 4000
const BOARD_RETENTION_MS = 14 * 24 * 60 * 60 * 1000
const RUN_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

export type PresenceFact = {
  reader: string
  role: 'operator' | 'architect' | 'worker'
  project: string
  machine: string
  lastSeen?: number
  live?: boolean
  runIds?: ReadonlySet<number>
  taskKeys?: ReadonlySet<string>
  taskAudienceOnly?: boolean
}
export type Audience =
  | { kind: 'operator' }
  | { kind: 'architects' }
  | { kind: 'project'; value: string }
  | { kind: 'workers'; value: string }
  | { kind: 'task'; value: string }
  | { kind: 'run'; value: number | string }
  | { kind: 'machine'; value: string }
  | { kind: 'session'; value: string }

export function parseAudience(expression: string): Audience {
  if (expression === 'operator') return { kind: 'operator' }
  if (expression === 'architects') return { kind: 'architects' }
  const match = /^(project|workers|task|run|machine|session):(.+)$/.exec(expression)
  if (!match?.[2]?.trim())
    throw new Error(
      `unsupported board audience ${expression}; use operator, architects, project:<name>, task:<KEY>, workers:<project>, run:<id>, machine:<name>, or session:<id>`,
    )
  if (match[1] === 'session' && (match[2] === OPERATOR_READER || match[2].startsWith('run:')))
    throw new Error(`session:${match[2]} is reserved; use audience ${match[2]}`)
  if (match[1] === 'run') {
    const id = Number(match[2])
    if (Number.isSafeInteger(id) && id > 0) return { kind: 'run', value: id }
    if (RUN_UUID.test(match[2])) return { kind: 'run', value: match[2] }
    throw new Error(`invalid run audience ${expression}; use run:<positive id>`)
  }
  return {
    kind: match[1] as 'project' | 'workers' | 'task' | 'machine' | 'session',
    value: match[2],
  }
}

export function audienceRefusal(
  audience: Audience,
  author: 'operator' | 'architect',
): string | null {
  return audience.kind === 'architects' && author !== 'operator'
    ? 'only the operator may address architects; use project:<name>'
    : null
}

export function runAudienceRefusal(
  audience: Audience,
  author: 'operator' | 'architect',
  authorSession: string | null,
  ownerSession: string | null,
): string | null {
  if (audience.kind !== 'run' || author === 'operator' || authorSession === ownerSession)
    return null
  const owner = ownerSession ? `is owned by session ${ownerSession}` : 'has no owning session'
  return `run ${audience.value} ${owner}; address project:<name> or workers:<project>, or ask the owner`
}

export function resolveAudience(
  audience: Audience,
  presence: PresenceFact[],
  now: number,
  liveWindowMs: number,
): string[] {
  if (audience.kind === 'operator') return [OPERATOR_READER]
  const live = presence.filter(
    (row) =>
      (audience.kind === 'task' || !row.taskAudienceOnly) &&
      (row.live !== undefined
        ? row.live
        : row.lastSeen !== undefined && now - row.lastSeen <= liveWindowMs && row.lastSeen <= now),
  )
  const readers = (facts: PresenceFact[]) => [...new Set(facts.map((row) => row.reader))]
  if (audience.kind === 'architects') return readers(live.filter((row) => row.role === 'architect'))
  if (audience.kind === 'project')
    return readers(live.filter((row) => row.project === audience.value))
  if (audience.kind === 'workers')
    return readers(live.filter((row) => row.role === 'worker' && row.project === audience.value))
  if (audience.kind === 'task')
    return readers(live.filter((row) => row.taskKeys?.has(audience.value)))
  if (audience.kind === 'run')
    return readers(
      live.filter(
        (row) =>
          row.role === 'worker' &&
          typeof audience.value === 'number' &&
          row.runIds?.has(audience.value),
      ),
    )
  if (audience.kind === 'machine')
    return readers(live.filter((row) => row.machine === audience.value))
  return readers(live.filter((row) => row.role === 'architect' && row.reader === audience.value))
}

export const shouldInterrupt = (message: {
  authorKind: string
  audienceKind: Audience['kind']
  ackRequired: boolean
  claimConflict?: boolean
}): boolean =>
  message.claimConflict === true ||
  (message.ackRequired && (message.authorKind === 'operator' || message.audienceKind === 'machine'))

export function requireRealSession(session: string, action: string): void {
  if (!session.trim() || session === OPERATOR_READER || session.startsWith('run:'))
    throw new Error(
      `${action} requires a real session id for an architect; use run:<id> only as a worker reader`,
    )
}

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

export function validatePostNoticeInput(input: {
  title: string
  body: string
  task?: string
  paths?: string[]
  topics?: string[]
  ackRequired?: boolean
  deadlineMs?: number
}): void {
  if (input.title.length > BOARD_TITLE_MAX_CHARS)
    throw new Error(`board notice title exceeds ${BOARD_TITLE_MAX_CHARS} characters; shorten it`)
  if (input.body.length > BOARD_BODY_MAX_CHARS)
    throw new Error(`board notice body exceeds ${BOARD_BODY_MAX_CHARS} characters; shorten it`)
  if (containsSecretShaped(input.title) || containsSecretShaped(input.body))
    throw new Error('board notice contains secret-shaped text; remove the credential and retry')
  if (
    [input.task, ...(input.paths ?? []), ...(input.topics ?? [])].some(
      (value) => value !== undefined && containsSecretShaped(value),
    )
  )
    throw new Error('board notice tag contains secret-shaped text; remove the credential and retry')
  if (!input.title.trim() || !input.body.trim())
    throw new Error('board notice title and body are required')
  if (input.deadlineMs !== undefined && !input.ackRequired)
    throw new Error('a board notice deadline requires acknowledgement to be required')
}

export const needsAckEscalation = (input: {
  ackRequired: boolean
  deadline: number | null
  expiresAt: number
  withdrawnAt: number | null
  acknowledgedAt: number | null
  audienceAtPosting: boolean
  now: number
}) =>
  input.ackRequired &&
  input.deadline !== null &&
  input.deadline <= input.now &&
  messageIsLive(input, input.now) &&
  input.acknowledgedAt === null &&
  input.audienceAtPosting
