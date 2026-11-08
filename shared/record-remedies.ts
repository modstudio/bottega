import { PLATFORM_SLUG } from './brand.ts'
import type { RefusalRemedy } from './refusal.ts'

export function recordSignInRemedy(email: string): Extract<RefusalRemedy, { kind: 'command' }> {
  return {
    kind: 'command',
    argv: [PLATFORM_SLUG, 'record', 'sign-in', '--email', email],
  }
}

export const RECORD_SIGN_IN_REMEDY = `record session is missing or expired; run \`${recordSignInRemedy('<email>').argv.join(' ')}\``
export const RECORD_ACTIVE_SPACE_REMEDY = `record session has no active space; run \`${PLATFORM_SLUG} record space switch <slug>\``
export const RUN_RETRY_REMEDY = `${PLATFORM_SLUG} run retry <run>`

export const machineNotTrustedRemedy = (spaceId: string) =>
  `this machine is not trusted in record space ${spaceId}; from a machine trusted there, run \`${PLATFORM_SLUG} machine config machine trust <keyId> <publicKey>\``

export const configAccessRemedy = (spaceId: string) =>
  `signed-in user lacks config access in record space ${spaceId}; a space owner or admin grants it with \`${PLATFORM_SLUG} record space access grant <email>\``

export const pinnedSpaceMismatchRemedy = (pinned: string) =>
  `record active space differs from this machine's initialized hosted-config space; switch back to ${pinned}, or remove this machine's hosted-config bootstrap and initialize it for the other space`

export const pinnedUserMismatchRemedy = (pinned: string) =>
  `record signed-in user differs from this machine's initialized hosted-config user; sign back in as ${pinned}, or remove this machine's hosted-config bootstrap and initialize it for the other user`
