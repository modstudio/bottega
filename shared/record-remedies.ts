import { PLATFORM_SLUG } from './brand.ts'
import { type RefusalRemedy, refusal, renderRefusal } from './refusal.ts'

export function recordSignInRemedy(email: string): Extract<RefusalRemedy, { kind: 'command' }> {
  return {
    kind: 'command',
    argv: [PLATFORM_SLUG, 'record', 'sign-in', '--email', email],
  }
}

export const RECORD_SIGN_IN_REMEDY = `record session is missing or expired; run \`${recordSignInRemedy('<email>').argv.join(' ')}\``
export const RECORD_ACTIVE_SPACE_REMEDY = `record session has no active space; run \`${PLATFORM_SLUG} record space switch <slug>\``
export const RUN_RETRY_REMEDY = `${PLATFORM_SLUG} run retry <run>`

export type HostedRequestSafety = 'probe' | 'idempotent' | 'non-idempotent'

export function hostedRequestSafetyStatement(outcome: HostedRequestSafety): string {
  if (outcome === 'probe') return 'nothing was written'
  if (outcome === 'idempotent') return 'safe to retry'
  return 'the write may have been applied; check before retrying'
}

export function recordUnreachableRefusal(
  origin: string,
  detail: string,
  outcome: HostedRequestSafety,
): string {
  return renderRefusal(
    refusal(
      `the hosted record at ${origin} could not be reached (${detail}); ${hostedRequestSafetyStatement(outcome)}`,
      {
        kind: 'command',
        argv: [PLATFORM_SLUG, 'record', 'doctor'],
      },
    ),
  )
}

export const machineNotTrustedRemedy = (spaceId: string) =>
  `this machine is not trusted in record space ${spaceId}; from a machine trusted there, run \`${PLATFORM_SLUG} machine config machine trust <keyId> <publicKey> --space ${spaceId}\``

export const configAccessRemedy = (space?: string) =>
  `signed-in user lacks config access${space ? ` in record space ${space}` : ''}; a space owner or admin grants it with \`${PLATFORM_SLUG} record space access grant <email>\``

export function declaredProjectSpaceRemedy(project: string): string {
  return `${PLATFORM_SLUG} project set ${project} --space <slug>`
}

export function undeclaredProjectSpaceRefusal(project: string): string {
  return `project ${project} has no declared record space; run \`${declaredProjectSpaceRemedy(project)}\``
}

export function recordSpaceMembershipRefusal(space: string): string {
  return (
    `the signed-in user is not a member of record space ${space}; ` +
    `an invitation from a member of that space is needed; list invitations with ` +
    `\`${PLATFORM_SLUG} record space invitations\`, then accept one with ` +
    `\`${PLATFORM_SLUG} record space accept <invitation-id>\``
  )
}

export function recordSpaceOwnerRequiredRemedy(
  verb: string,
  alternatives: readonly ('project' | 'account')[] = [],
): string {
  const flags = [
    '--space <slug>',
    ...alternatives.map((alternative) =>
      alternative === 'project' ? '--project <name>' : '--account',
    ),
  ]
  return `${verb} writes to a record space and names none; pass ${flags.join(', or ')}`
}

export const pinnedSpaceMismatchRemedy = (pinned: string) =>
  `record active space differs from this machine's initialized hosted-config space; switch back to ${pinned}, or remove this machine's hosted-config bootstrap and initialize it for the other space`

export const pinnedUserMismatchRemedy = (pinned: string) =>
  `record signed-in user differs from this machine's initialized hosted-config user; sign back in as ${pinned}, or remove this machine's hosted-config bootstrap and initialize it for the other user`
