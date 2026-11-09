// concern: credential-decision
/** Pure payer-resolution rules and the refusal shape for a credential that must be set. */

import { PLATFORM_SLUG } from './brand.ts'
import {
  type CredentialEnvironment,
  type CredentialIdentity,
  type CredentialMode,
  type CredentialPayer,
  type CredentialPreferencePayload,
  credentialIdentityPath,
} from './credential.ts'

export type CredentialCandidate = CredentialIdentity & {
  spaceId: string
  payer: CredentialPayer
  account?: {
    ownerUserId: string
    reachSpaceIds: readonly string[] | null
  }
}

export type CredentialResolution<Candidate extends CredentialCandidate = CredentialCandidate> =
  | {
      kind: 'resolved'
      credential: Candidate
      reason: 'project-preference' | 'space-preference' | 'account' | 'default-order'
    }
  | { kind: 'refused'; refusal: string }

export function credentialMatchesPreferenceSlot(
  credential: CredentialCandidate,
  preference: CredentialPreferencePayload,
  projectId: string | null,
): boolean {
  return (
    credential.payer === preference.payer &&
    (preference.binding === 'account'
      ? credential.account !== undefined
      : credential.account === undefined &&
        (preference.binding === 'project'
          ? projectId !== null && credential.projectId === projectId
          : credential.projectId === null))
  )
}

export function credentialPayerFromScope(scope: 'user' | 'space'): CredentialPayer {
  return scope === 'user' ? 'personal' : 'shared'
}

export function credentialScopeFromPayer(payer: CredentialPayer): 'user' | 'space' {
  return payer === 'personal' ? 'user' : 'space'
}

/** Where a credential set is aimed; a project binding wins over its space. */
export type CredentialSetTarget = {
  provider: string
  name: string | null
  type: string
  mode: CredentialMode
  environment: CredentialEnvironment
  payer: CredentialPayer
  account?: boolean
  projectName?: string | null
  spaceName?: string
}

/** One refusal shape for every credential that must be set: names the binding and the exact set command. */
export function credentialSetRefusalText(
  target: CredentialSetTarget,
  condition: string,
  action: string,
): string {
  const name = credentialIdentityPath(target.provider, target.name, target.type)
  const binding = target.account
    ? 'account'
    : target.projectName
      ? `project ${target.projectName}`
      : `space ${target.spaceName}`
  const bindOption = target.account
    ? ' --account'
    : target.projectName
      ? ` --project ${target.projectName}`
      : ` --space ${target.spaceName}`
  const payerOption = target.payer === 'shared' ? ' --shared' : ''
  const modeOption = target.mode === 'default' ? '' : ` --mode ${target.mode}`
  const environmentOption = target.environment === 'local' ? '' : ` --env ${target.environment}`
  return `credential ${name} (mode ${target.mode}, env ${target.environment}) is ${condition} for ${binding}; ${action} \`${PLATFORM_SLUG} credential set ${name}${bindOption}${payerOption}${modeOption}${environmentOption}\``
}

type CredentialRequest = {
  userId: string
  personalSpaceId: string | null
  spaceId: string
  projectId: string | null
  provider: string
  name: string | null
  type: string
  mode: CredentialMode
  environment: CredentialEnvironment
}

function candidateMatchesRequest(row: CredentialCandidate, input: CredentialRequest): boolean {
  const accountMatches =
    row.account !== undefined &&
    row.payer === 'personal' &&
    row.projectId === null &&
    row.spaceId === input.personalSpaceId &&
    row.account.ownerUserId === input.userId &&
    (row.account.reachSpaceIds === null || row.account.reachSpaceIds.includes(input.spaceId))
  const destinationMatches = row.account === undefined && row.spaceId === input.spaceId
  const projectMatches =
    input.projectId === null
      ? row.projectId === null
      : row.projectId === input.projectId || row.projectId === null
  return (
    (accountMatches || destinationMatches) &&
    projectMatches &&
    row.provider === input.provider &&
    row.name === input.name &&
    row.type === input.type &&
    row.mode === input.mode &&
    row.environment === input.environment
  )
}

function preferredReason(
  credential: CredentialCandidate,
  projectId: string | null,
  preference: CredentialPreferencePayload,
): 'account' | 'project-preference' | 'space-preference' {
  if (credential.account !== undefined) return 'account'
  return projectId !== null && preference.projectId ? 'project-preference' : 'space-preference'
}

export function resolveCredential<Candidate extends CredentialCandidate>(
  input: CredentialRequest & {
    projectName?: string
    spaceName?: string
    provider: string
    name: string | null
    type: string
    mode: CredentialMode
    environment: CredentialEnvironment
    candidates: readonly Candidate[]
    preferences: readonly CredentialPreferencePayload[]
  },
): CredentialResolution<Candidate> {
  const candidates = input.candidates.filter((row) => candidateMatchesRequest(row, input))
  const preferences = input.preferences.filter(
    (row) =>
      row.provider === input.provider &&
      row.name === input.name &&
      row.type === input.type &&
      row.mode === input.mode &&
      row.environment === input.environment,
  )
  const preference =
    (input.projectId === null
      ? undefined
      : preferences.find((row) => row.projectId === input.projectId)) ??
    preferences.find((row) => row.projectId === null)
  if (preference) {
    const preferred = candidates.find((row) =>
      credentialMatchesPreferenceSlot(row, preference, input.projectId),
    )
    if (preferred)
      return {
        kind: 'resolved',
        credential: preferred,
        reason: preferredReason(preferred, input.projectId, preference),
      }
  }
  const order: readonly [CredentialPayer, string | null, boolean][] =
    input.projectId === null
      ? [
          ['personal', null, false],
          ['personal', null, true],
          ['shared', null, false],
        ]
      : [
          ['personal', input.projectId, false],
          ['personal', null, false],
          ['personal', null, true],
          ['shared', input.projectId, false],
          ['shared', null, false],
        ]
  for (const [payer, projectId, account] of order) {
    const credential = candidates.find(
      (row) =>
        row.payer === payer &&
        row.projectId === projectId &&
        (row.account !== undefined) === account,
    )
    if (credential)
      return { kind: 'resolved', credential, reason: account ? 'account' : 'default-order' }
  }
  return {
    kind: 'refused',
    refusal: credentialSetRefusalText(
      { ...input, payer: 'personal' },
      'missing',
      'pipe its value to',
    ),
  }
}
