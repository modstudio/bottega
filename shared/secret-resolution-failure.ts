import { PLATFORM_SLUG } from './brand.ts'
import { ConfigClientError } from './config-client.ts'
import { HostedSecretError } from './hosted-secrets.ts'

/** Classify a sealed-store read failure without repeating sensitive exception details. */
export function secretResolutionFailure(error: unknown): string | null {
  if (error instanceof ConfigClientError) {
    const condition =
      error.reason === 'unreachable'
        ? 'hosted secret service is unreachable'
        : 'hosted secret service refused the request'
    return `${condition}\ncleared by: ${PLATFORM_SLUG} record doctor`
  }
  if (!(error instanceof HostedSecretError)) return null
  const condition = `hosted secret ${error.secretName} could not be opened: ${error.reason}`
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
      return `${condition}\ncleared by: ${PLATFORM_SLUG} record doctor`
  }
}
