// concern: credential-decision
/** Pure credential identity, presentation, hint, and payer-resolution rules. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'

const CREDENTIAL_HINT_MIN_LENGTH = 20
export const CREDENTIAL_ENVIRONMENTS = ['live', 'test', 'default'] as const
export type CredentialEnvironment = (typeof CREDENTIAL_ENVIRONMENTS)[number]
export type CredentialPayer = 'personal' | 'shared'
type CredentialBinding = 'project' | 'space'

export type CredentialCandidate = {
  spaceId: string
  projectId: string | null
  payer: CredentialPayer
  provider: string
  type: string
  environment: CredentialEnvironment
}

export type CredentialPreference = {
  projectId: string | null
  provider: string
  type: string
  environment: CredentialEnvironment
  payer: CredentialPayer
  binding: CredentialBinding
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
  preference: CredentialPreference,
  projectId: string,
): boolean {
  return (
    credential.payer === preference.payer &&
    (preference.binding === 'project'
      ? credential.projectId === projectId
      : credential.projectId === null)
  )
}

export function resolveCredential(input: {
  spaceId: string
  projectId: string
  projectName: string
  userId: string
  provider: string
  type: string
  environment: CredentialEnvironment
  candidates: readonly CredentialCandidate[]
  preferences: readonly CredentialPreference[]
}): CredentialResolution {
  const candidates = input.candidates.filter(
    (row) =>
      row.spaceId === input.spaceId &&
      row.provider === input.provider &&
      row.type === input.type &&
      row.environment === input.environment &&
      (row.projectId === input.projectId || row.projectId === null),
  )
  const preference =
    input.preferences.find((row) => row.projectId === input.projectId) ??
    input.preferences.find((row) => row.projectId === null)
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
  const address = `${input.provider}/${input.type}`
  return {
    kind: 'refused',
    refusal:
      `credential ${address} (${input.environment}) is missing for project ${input.projectName}; ` +
      `pipe its value to \`${PLATFORM_SLUG} credential set ${address} --project ${input.projectName}${input.environment === 'default' ? '' : ` --env ${input.environment}`}\``,
  }
}
