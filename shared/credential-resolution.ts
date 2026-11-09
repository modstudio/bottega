// concern: credential-decision
/** Pure credential presentation, hint, and payer-resolution rules. */

import { PLATFORM_SLUG } from './brand.ts'
import type {
  CredentialEnvironment,
  CredentialIdentity,
  CredentialMode,
  CredentialPayer,
  CredentialPreferencePayload,
} from './credential.ts'

export type CredentialCandidate = CredentialIdentity & {
  spaceId: string
  payer: CredentialPayer
}

export type CredentialResolution<Candidate extends CredentialCandidate = CredentialCandidate> =
  | {
      kind: 'resolved'
      credential: Candidate
      reason: 'project-preference' | 'space-preference' | 'default-order'
    }
  | { kind: 'refused'; refusal: string }

function matchesSlot(
  credential: CredentialCandidate,
  preference: CredentialPreferencePayload,
  projectId: string | null,
): boolean {
  return (
    credential.payer === preference.payer &&
    (preference.binding === 'project'
      ? projectId !== null && credential.projectId === projectId
      : credential.projectId === null)
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
  projectName?: string | null
  spaceName?: string
}

/** One refusal shape for every credential that must be set: names the binding and the exact set command. */
export function credentialSetRefusalText(
  target: CredentialSetTarget,
  condition: string,
  action: string,
): string {
  const name = [target.provider, target.name, target.type].filter((part) => part !== null).join('/')
  const binding = target.projectName ? `project ${target.projectName}` : `space ${target.spaceName}`
  const bindOption = target.projectName
    ? ` --project ${target.projectName}`
    : ` --space ${target.spaceName}`
  const payerOption = target.payer === 'shared' ? ' --shared' : ''
  const modeOption = target.mode === 'default' ? '' : ` --mode ${target.mode}`
  const environmentOption = target.environment === 'local' ? '' : ` --env ${target.environment}`
  return `credential ${name} (mode ${target.mode}, env ${target.environment}) is ${condition} for ${binding}; ${action} \`${PLATFORM_SLUG} credential set ${name}${bindOption}${payerOption}${modeOption}${environmentOption}\``
}

export function resolveCredential<Candidate extends CredentialCandidate>(input: {
  spaceId: string
  projectId: string | null
  projectName?: string
  spaceName?: string
  provider: string
  name: string | null
  type: string
  mode: CredentialMode
  environment: CredentialEnvironment
  candidates: readonly Candidate[]
  preferences: readonly CredentialPreferencePayload[]
}): CredentialResolution<Candidate> {
  const candidates = input.candidates.filter(
    (row) =>
      row.spaceId === input.spaceId &&
      row.provider === input.provider &&
      row.name === input.name &&
      row.type === input.type &&
      row.mode === input.mode &&
      row.environment === input.environment &&
      (input.projectId === null
        ? row.projectId === null
        : row.projectId === input.projectId || row.projectId === null),
  )
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
    const preferred = candidates.find((row) => matchesSlot(row, preference, input.projectId))
    if (preferred)
      return {
        kind: 'resolved',
        credential: preferred,
        reason:
          input.projectId !== null && preference.projectId
            ? 'project-preference'
            : 'space-preference',
      }
  }
  const order: readonly [CredentialPayer, string | null][] =
    input.projectId === null
      ? [
          ['personal', null],
          ['shared', null],
        ]
      : [
          ['personal', input.projectId],
          ['personal', null],
          ['shared', input.projectId],
          ['shared', null],
        ]
  for (const [payer, projectId] of order) {
    const credential = candidates.find((row) => row.payer === payer && row.projectId === projectId)
    if (credential) return { kind: 'resolved', credential, reason: 'default-order' }
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
