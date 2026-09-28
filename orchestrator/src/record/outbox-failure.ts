// concern: outbox-failure
/** Pure classification of one hosted-record outbox failure. */
import { RecordVerdictError } from './record-verdicts.ts'

export type OutboxFailureFacts = {
  sqlState: string | null
  serverMessage: string | null
  errorClass:
    | 'declared-space'
    | 'migration-mismatch'
    | 'payload'
    | 'verdict-rule'
    | 'row-validation'
    | 'unknown'
  responseReceived: boolean
}

export type OutboxFailureDisposition = 'pass-fatal' | 'row-fatal'

export class OutboxRowError extends Error {
  readonly errorClass: Exclude<OutboxFailureFacts['errorClass'], 'unknown' | 'verdict-rule'>
  readonly blockedProject: string | null

  constructor(
    message: string,
    errorClass: Exclude<OutboxFailureFacts['errorClass'], 'unknown' | 'verdict-rule'>,
    blockedProject: string | null = null,
  ) {
    super(message)
    this.errorClass = errorClass
    this.blockedProject = blockedProject
  }
}

const MIGRATION_MISMATCH_STATES = new Set(['42P01', '42703', '42883', '3F000'])
const SESSION_FAILURE_STATES = new Set(['57P01', '57P02', '57P03', '25006'])

export function classifyOutboxFailure(facts: OutboxFailureFacts): OutboxFailureDisposition {
  if (facts.errorClass === 'migration-mismatch') return 'pass-fatal'
  if (facts.errorClass !== 'unknown') return 'row-fatal'
  if (!facts.responseReceived) return 'pass-fatal'
  const sqlState = facts.sqlState?.toUpperCase() ?? null
  if (!sqlState) return 'pass-fatal'
  if (sqlState.startsWith('08') || sqlState.startsWith('28')) return 'pass-fatal'
  if (MIGRATION_MISMATCH_STATES.has(sqlState) || SESSION_FAILURE_STATES.has(sqlState)) {
    return 'pass-fatal'
  }
  if (sqlState === '42501') {
    return facts.serverMessage?.includes('violates row-level security policy')
      ? 'row-fatal'
      : 'pass-fatal'
  }
  if (sqlState.startsWith('22') || sqlState.startsWith('23')) {
    return 'row-fatal'
  }
  return 'pass-fatal'
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current !== null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    chain.push(current)
    current = 'cause' in current ? current.cause : null
  }
  return chain
}

export function outboxErrorDetail(error: unknown): string {
  const details: string[] = []
  for (const current of errorChain(error)) {
    const message = current instanceof Error ? current.message : String(current)
    const candidate = current as { code?: unknown; errno?: unknown }
    const code = typeof candidate.code === 'string' ? candidate.code : null
    const errno =
      typeof candidate.errno === 'string' || typeof candidate.errno === 'number'
        ? String(candidate.errno)
        : null
    const label = errno ?? code
    const detail = label ? `[${label}] ${message}` : message
    if (!details.includes(detail)) details.push(detail)
  }
  return details.join('\ncaused by: ')
}

function postgresFailureFacts(chain: readonly unknown[]) {
  let sqlState: string | null = null
  let serverMessage: string | null = null
  for (const item of chain) {
    const candidate = item as { code?: unknown; errno?: unknown }
    for (const value of [candidate.errno, candidate.code]) {
      if (typeof value !== 'string' && typeof value !== 'number') continue
      const normalized = String(value).toUpperCase()
      if (/^[0-9A-Z]{5}$/.test(normalized)) sqlState ??= normalized
    }
    if (candidate.code === 'ERR_POSTGRES_SERVER_ERROR') {
      serverMessage ??= item instanceof Error ? item.message : String(item)
    }
  }
  return { sqlState, serverMessage, responseReceived: serverMessage !== null || sqlState !== null }
}

function outboxErrorClass(chain: readonly unknown[]): OutboxFailureFacts['errorClass'] {
  const rowError = chain.find((item) => item instanceof OutboxRowError)
  if (rowError instanceof OutboxRowError) return rowError.errorClass
  if (chain.some((item) => item instanceof RecordVerdictError)) return 'verdict-rule'
  const validation = chain.some(
    (item) =>
      item instanceof Error &&
      (item instanceof SyntaxError || item instanceof RangeError || item.name === 'ZodError'),
  )
  return validation ? 'row-validation' : 'unknown'
}

export function outboxFailureDisposition(error: unknown): OutboxFailureDisposition {
  const chain = errorChain(error)
  return classifyOutboxFailure({
    ...postgresFailureFacts(chain),
    errorClass: outboxErrorClass(chain),
  })
}

export function unreachableSpaceProject(error: unknown): string | null {
  const refusal = errorChain(error).find(
    (item) => item instanceof OutboxRowError && item.errorClass === 'declared-space',
  )
  return refusal instanceof OutboxRowError ? refusal.blockedProject : null
}
