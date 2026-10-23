import { PLATFORM_SLUG } from './brand.ts'
import { ConfigClientError, type ConfigClientErrorReason } from './config-client.ts'
import { HostedSecretError } from './hosted-secrets.ts'
import { RECORD_SIGN_IN_REMEDY } from './record-remedies.ts'

type SecretResolutionFailureOptions = {
  exhaustedRetryCommand?: string
}

export type SecretResolutionFailureClassification =
  | { kind: 'hosted-failure' }
  | { kind: 'config-client'; reason: ConfigClientErrorReason; status?: number }

/** Reduce a secret-resolution exception to the non-sensitive facts retry policy needs. */
export function classifySecretResolutionFailure(
  error: unknown,
): SecretResolutionFailureClassification | null {
  if (error instanceof HostedSecretError && error.reason === 'hosted-failure')
    return { kind: 'hosted-failure' }
  if (error instanceof ConfigClientError)
    return { kind: 'config-client', reason: error.reason, status: error.status }
  return null
}

function hostedFailureCauseSummary(error: HostedSecretError): string {
  const cause = error.cause
  if ((typeof cause !== 'object' && typeof cause !== 'function') || cause === null) return ''
  try {
    const constructorName = cause.constructor?.name
    if (!constructorName) return ''
    const facts = [`cause: ${constructorName}`]
    const status = 'status' in cause ? cause.status : undefined
    if (typeof status === 'number') facts.push(`status: ${status}`)
    if (cause instanceof ConfigClientError) facts.push(`reason: ${cause.reason}`)
    const code = 'code' in cause ? cause.code : undefined
    if (typeof code === 'string' || typeof code === 'number') facts.push(`code: ${code}`)
    return ` (${facts.join(', ')})`
  } catch {
    return ''
  }
}

/** Classify a sealed-store read failure without repeating sensitive exception details. */
export function secretResolutionFailure(
  error: unknown,
  options: SecretResolutionFailureOptions = {},
): string | null {
  if (error instanceof ConfigClientError) {
    const condition =
      error.reason === 'unreachable'
        ? 'hosted secret service is unreachable'
        : 'hosted secret service refused the request'
    if (options.exhaustedRetryCommand) {
      const diagnostic =
        error.reason === 'unreachable' ? `\nchecked by: ${PLATFORM_SLUG} record doctor` : ''
      return `${condition}${diagnostic}\ncleared by: ${options.exhaustedRetryCommand}`
    }
    if (error.reason === 'unreachable')
      return `${condition}\ncleared by: ${PLATFORM_SLUG} record doctor`
    if (error.reason === 'not-configured')
      return `${condition}\ncleared by: ${RECORD_SIGN_IN_REMEDY}`
    return `${condition}\ncleared by: restore hosted secret access, then retry`
  }
  if (!(error instanceof HostedSecretError)) return null
  const causeSummary = error.reason === 'hosted-failure' ? hostedFailureCauseSummary(error) : ''
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
      return `${condition}\ncleared by: ${options.exhaustedRetryCommand ?? 'retry the command'}`
  }
}
