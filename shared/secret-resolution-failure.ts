import { PLATFORM_SLUG } from './brand.ts'
import { ConfigClientError, type ConfigClientErrorReason } from './config-client.ts'
import { HostedSecretError } from './hosted-secrets.ts'
import { RECORD_SIGN_IN_REMEDY } from './record-remedies.ts'

type SecretResolutionFailureOptions = {
  exhaustedRetryCommand?: string
  /**
   * The `checked by:` line that names where an unreachable service is confirmed, or `null` to omit
   * the line. Omitting the option names the record doctor, which is the surface that reports it;
   * the doctor itself passes `null` because its own remedy must not send the operator back to it.
   */
  unreachableDiagnostic?: string | null
}

const DEFAULT_UNREACHABLE_DIAGNOSTIC = `checked by: ${PLATFORM_SLUG} record doctor`

type HostedFailureCause = {
  constructorName: string
  status?: number
  reason?: ConfigClientErrorReason
  code?: string | number
}

export type SecretResolutionFailureClassification =
  | { kind: 'hosted-failure'; cause?: HostedFailureCause }
  | {
      kind: 'config-client'
      reason: ConfigClientErrorReason
      status?: number
      cause?: HostedFailureCause
    }

function classifyHostedFailureCause(cause: unknown): HostedFailureCause | undefined {
  if ((typeof cause !== 'object' && typeof cause !== 'function') || cause === null) return undefined
  try {
    const constructorName = cause.constructor?.name
    if (!constructorName) return undefined
    const status = 'status' in cause ? cause.status : undefined
    const code = 'code' in cause ? cause.code : undefined
    return {
      constructorName,
      ...(typeof status === 'number' ? { status } : {}),
      ...(cause instanceof ConfigClientError ? { reason: cause.reason } : {}),
      ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
    }
  } catch {
    return undefined
  }
}

/** Reduce a secret read exception to non-sensitive policy and rendering facts. */
export function classifySecretResolutionFailure(
  error: unknown,
): SecretResolutionFailureClassification | null {
  if (error instanceof HostedSecretError && error.reason === 'hosted-failure') {
    const cause = classifyHostedFailureCause(error.cause)
    if (error.cause instanceof ConfigClientError)
      return {
        kind: 'config-client',
        reason: error.cause.reason,
        status: error.cause.status,
        ...(cause ? { cause } : {}),
      }
    return { kind: 'hosted-failure', ...(cause ? { cause } : {}) }
  }
  if (error instanceof ConfigClientError)
    return { kind: 'config-client', reason: error.reason, status: error.status }
  return null
}

/** Whether the classified secret failure can reasonably clear without operator repair. */
export function isTransientSecretResolutionFailure(
  classification: SecretResolutionFailureClassification | null,
): boolean {
  return (
    classification?.kind === 'hosted-failure' ||
    (classification?.kind === 'config-client' &&
      (classification.reason === 'unreachable' ||
        classification.status === 429 ||
        (classification.status !== undefined &&
          classification.status >= 500 &&
          classification.status <= 599)))
  )
}

function hostedFailureCauseSummary(
  classification: SecretResolutionFailureClassification | null,
): string {
  const cause = classification?.cause
  if (!cause) return ''
  const facts = [`cause: ${cause.constructorName}`]
  if (cause.status !== undefined) facts.push(`status: ${cause.status}`)
  if (cause.reason !== undefined) facts.push(`reason: ${cause.reason}`)
  if (cause.code !== undefined) facts.push(`code: ${cause.code}`)
  return ` (${facts.join(', ')})`
}

function configClientRemedy(
  classification: Extract<SecretResolutionFailureClassification, { kind: 'config-client' }>,
  options: SecretResolutionFailureOptions,
) {
  if (options.exhaustedRetryCommand) {
    const { unreachableDiagnostic = DEFAULT_UNREACHABLE_DIAGNOSTIC } = options
    const diagnostic = classification.reason === 'unreachable' ? unreachableDiagnostic : null
    return `${diagnostic ? `\n${diagnostic}` : ''}\ncleared by: ${options.exhaustedRetryCommand}`
  }
  if (classification.reason === 'unreachable') return `\ncleared by: ${PLATFORM_SLUG} record doctor`
  if (classification.reason === 'not-configured') return `\ncleared by: ${RECORD_SIGN_IN_REMEDY}`
  return '\ncleared by: restore hosted secret access, then retry'
}

/** Classify a sealed-store read failure without repeating sensitive exception details. */
export function secretResolutionFailure(
  error: unknown,
  options: SecretResolutionFailureOptions = {},
): string | null {
  const classification = classifySecretResolutionFailure(error)
  if (error instanceof ConfigClientError && classification?.kind === 'config-client') {
    const condition =
      error.reason === 'unreachable'
        ? 'hosted secret service is unreachable'
        : 'hosted secret service refused the request'
    return `${condition}${configClientRemedy(classification, options)}`
  }
  if (!(error instanceof HostedSecretError)) return null
  const causeSummary = hostedFailureCauseSummary(classification)
  const condition = `hosted secret ${error.secretName} could not be opened: ${error.reason}${causeSummary}`
  switch (error.reason) {
    case 'machine-key-missing':
      return `${condition}\ncleared by: ${PLATFORM_SLUG} machine config machine init`
    case 'missing-wrap':
      return `${condition}\ncleared by: restore this machine's data-key wrap, then retry`
    case 'untrusted-sender':
      return `${condition}\ncleared by: trust the sealing machine with ${PLATFORM_SLUG} machine config machine trust <keyId> <publicKey>, then retry`
    case 'authentication-failed':
      return `${condition}\ncleared by: repair the sealed value from a trusted machine, then retry`
    case 'hosted-failure':
      if (classification?.kind === 'config-client')
        return `${condition}${configClientRemedy(classification, options)}`
      return `${condition}\ncleared by: ${options.exhaustedRetryCommand ?? `${PLATFORM_SLUG} record doctor`}`
  }
}
