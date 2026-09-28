// concern: outbox-failure
/** Pure classification of one hosted-record outbox failure. */
import { RecordVerdictError } from './record-verdicts.ts'

export type OutboxFailureFacts = {
  sqlState: string | null
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
  if (sqlState.startsWith('22') || sqlState.startsWith('23') || sqlState === '42501') {
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
    const candidate = current as { code?: unknown }
    const code = typeof candidate.code === 'string' ? candidate.code : null
    const detail = code ? `[${code}] ${message}` : message
    if (!details.includes(detail)) details.push(detail)
  }
  return details.join('\ncaused by: ')
}

export function outboxFailureDisposition(error: unknown): OutboxFailureDisposition {
  const chain = errorChain(error)
  const coded = chain.find(
    (item): item is { code: string } =>
      item !== null && typeof item === 'object' && 'code' in item && typeof item.code === 'string',
  )
  const sqlState = coded?.code ?? null
  for (const item of chain) {
    if (item instanceof OutboxRowError) {
      return classifyOutboxFailure({
        sqlState,
        errorClass: item.errorClass,
        responseReceived: sqlState !== null,
      })
    }
    if (item instanceof RecordVerdictError) {
      return classifyOutboxFailure({ sqlState, errorClass: 'verdict-rule', responseReceived: true })
    }
    if (
      item instanceof Error &&
      (item instanceof SyntaxError || item instanceof RangeError || item.name === 'ZodError')
    ) {
      return classifyOutboxFailure({
        sqlState,
        errorClass: 'row-validation',
        responseReceived: true,
      })
    }
  }
  return classifyOutboxFailure({
    sqlState,
    errorClass: 'unknown',
    responseReceived: sqlState !== null,
  })
}

export function unreachableSpaceProject(error: unknown): string | null {
  const refusal = errorChain(error).find(
    (item) => item instanceof OutboxRowError && item.errorClass === 'declared-space',
  )
  return refusal instanceof OutboxRowError ? refusal.blockedProject : null
}
