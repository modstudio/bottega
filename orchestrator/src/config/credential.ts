// concern: credential-decision
/** Pure credential identity, presentation, hint, and payer-resolution rules. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type {
  CredentialBinding,
  CredentialEnvironment,
  CredentialIdentity,
  CredentialPayer,
  CredentialPreferencePayload,
} from '../../../shared/credential.ts'
import { CREDENTIAL_BINDINGS, CREDENTIAL_PAYERS } from '../../../shared/credential.ts'

const CREDENTIAL_HINT_MIN_LENGTH = 20

export type { CredentialEnvironment, CredentialPayer } from '../../../shared/credential.ts'

export type CredentialCandidate = CredentialIdentity & {
  spaceId: string
  payer: CredentialPayer
}

export type CredentialResolution =
  | {
      kind: 'resolved'
      credential: CredentialCandidate
      reason: 'project-preference' | 'space-preference' | 'default-order'
    }
  | { kind: 'refused'; refusal: string }

export function credentialHint(value: string): string {
  return value.length >= CREDENTIAL_HINT_MIN_LENGTH
    ? `${value.slice(0, 4)}…${value.slice(-4)}`
    : `${value.length} characters`
}

const upperSnake = (value: string) => value.toUpperCase().replaceAll('-', '_')

export function credentialVariableName(
  provider: string,
  type: string,
  environment: CredentialEnvironment,
): string {
  const base = `${upperSnake(provider)}_${upperSnake(type)}`
  return environment === 'test' ? `${base}_TEST` : base
}

export function credentialDisplayName(
  provider: string,
  type: string,
  environment: CredentialEnvironment,
): string {
  return `${provider}/${type}${environment === 'test' ? '/test' : ''}`
}

function matchesSlot(
  credential: CredentialCandidate,
  preference: CredentialPreferencePayload,
  projectId: string,
): boolean {
  return (
    credential.payer === preference.payer &&
    (preference.binding === 'project'
      ? credential.projectId === projectId
      : credential.projectId === null)
  )
}

export function credentialSlot(payer: CredentialPayer, projectId: string | null): string {
  return `${payer}@${projectId ? 'project' : 'space'}`
}

export function parseCredentialSlot(
  value: string,
): { payer: CredentialPayer; binding: CredentialBinding } | null {
  for (const payer of CREDENTIAL_PAYERS)
    for (const binding of CREDENTIAL_BINDINGS)
      if (value === `${payer}@${binding}`) return { payer, binding }
  return null
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
  type: string
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
  const name = `${target.provider}/${target.type}`
  const binding = target.projectName ? `project ${target.projectName}` : `space ${target.spaceName}`
  const bindOption = target.projectName
    ? ` --project ${target.projectName}`
    : ` --space ${target.spaceName}`
  const payerOption = target.payer === 'shared' ? ' --shared' : ''
  const environmentOption = target.environment === 'default' ? '' : ` --env ${target.environment}`
  return `credential ${name} (${target.environment}) is ${condition} for ${binding}; ${action} \`${PLATFORM_SLUG} credential set ${name}${bindOption}${payerOption}${environmentOption}\``
}

export function resolveCredential(input: {
  spaceId: string
  projectId: string
  projectName: string
  provider: string
  type: string
  environment: CredentialEnvironment
  candidates: readonly CredentialCandidate[]
  preferences: readonly CredentialPreferencePayload[]
}): CredentialResolution {
  const candidates = input.candidates.filter(
    (row) =>
      row.spaceId === input.spaceId &&
      row.provider === input.provider &&
      row.type === input.type &&
      row.environment === input.environment &&
      (row.projectId === input.projectId || row.projectId === null),
  )
  const preferences = input.preferences.filter(
    (row) =>
      row.provider === input.provider &&
      row.type === input.type &&
      row.environment === input.environment,
  )
  const preference =
    preferences.find((row) => row.projectId === input.projectId) ??
    preferences.find((row) => row.projectId === null)
  if (preference) {
    const preferred = candidates.find((row) => matchesSlot(row, preference, input.projectId))
    if (preferred)
      return {
        kind: 'resolved',
        credential: preferred,
        reason: preference.projectId ? 'project-preference' : 'space-preference',
      }
  }
  const order: readonly [CredentialPayer, string | null][] = [
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
