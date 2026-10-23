import { PLATFORM_SLUG } from './brand.ts'
import { ConfigClientError } from './config-client.ts'
import { HostedSecretError } from './hosted-secrets.ts'
import { RECORD_SIGN_IN_REMEDY } from './record-remedies.ts'

type SecretResolutionFailureOptions = {
  exhaustedRetryCommand?: string
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

function configClientRemedy(error: ConfigClientError, options: SecretResolutionFailureOptions) {
  if (options.exhaustedRetryCommand) {
    const diagnostic =
      error.reason === 'unreachable' ? `\nchecked by: ${PLATFORM_SLUG} record doctor` : ''
    return `${diagnostic}\ncleared by: ${options.exhaustedRetryCommand}`
  }
  if (error.reason === 'unreachable') return `\ncleared by: ${PLATFORM_SLUG} record doctor`
  if (error.reason === 'not-configured') return `\ncleared by: ${RECORD_SIGN_IN_REMEDY}`
  return '\ncleared by: restore hosted secret access, then retry'
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
    return `${condition}${configClientRemedy(error, options)}`
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
      if (error.cause instanceof ConfigClientError)
        return `${condition}${configClientRemedy(error.cause, options)}`
      return `${condition}\ncleared by: ${options.exhaustedRetryCommand ?? 'retry the command'}`
  }
}
