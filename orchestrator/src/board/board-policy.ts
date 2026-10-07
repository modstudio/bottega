import { containsSecretShaped } from '../../../shared/secret-shaped.ts'
import { classifyCaller } from '../caller-classification.ts'

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
export function architectIdentity(
  env: Record<string, string | undefined>,
): ArchitectIdentity | null {
  const caller = classifyCaller(env)
  if (caller.kind !== 'harness' || caller.session === OPERATOR_READER) return null
  return { session: caller.session, harness: caller.harness }
}

export type PresenceFact = {
  reader: string
  role: 'operator' | 'architect' | 'worker'
  project: string
  machine: string
  lastSeen?: number
  live?: boolean
  runIds?: ReadonlySet<number | string>
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

export function acknowledgementRefusal(input: {
  ackRequired: boolean
  audience: Audience
  authorKind: 'operator' | 'architect'
  authorProject: string | null
}): string | null {
  if (!input.ackRequired || input.authorKind === 'operator') return null
  if (input.audience.kind === 'project' && input.audience.value === input.authorProject) return null
  return 'an architect may require acknowledgement only for project:<your project>; address project:<your project>, or post without acknowledgement'
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
    return readers(live.filter((row) => row.role === 'worker' && row.runIds?.has(audience.value)))
  if (audience.kind === 'machine')
    return readers(live.filter((row) => row.machine === audience.value))
  return readers(live.filter((row) => row.role === 'architect' && row.reader === audience.value))
}

export const shouldInterrupt = (message: {
  authorKind: string
  authorIsSignedInUser?: boolean
  audienceKind: Audience['kind']
  ackRequired: boolean
  claimConflict?: boolean
  ownPost?: boolean
}): boolean => {
  if (message.ownPost) return false
  return (
    message.claimConflict === true ||
    (message.ackRequired &&
      !(message.authorKind === 'operator' && message.authorIsSignedInUser === false))
  )
}

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
  const lineBreak = /[\r\n\u2028\u2029]/
  const headerFields: Array<[string, string | undefined]> = [
    ['title', input.title],
    ['task tag', input.task],
    ...(input.paths ?? []).map((value) => ['path tag', value] as [string, string]),
    ...(input.topics ?? []).map((value) => ['topic', value] as [string, string]),
  ]
  for (const [field, value] of headerFields)
    if (value !== undefined && lineBreak.test(value))
      throw new Error(`board notice ${field} contains a line break; remove it and retry`)
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
