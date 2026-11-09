// concern: credential-decision
/** Pure credential presentation, hint, and payer-resolution rules. */

import { PLATFORM_SLUG } from './brand.ts'
import type {
  CredentialBinding,
  CredentialEnvironment,
  CredentialIdentity,
  CredentialMode,
  CredentialPayer,
  CredentialPreferencePayload,
} from './credential.ts'
import { CREDENTIAL_BINDINGS, CREDENTIAL_PAYERS } from './credential.ts'

const CREDENTIAL_HINT_MIN_LENGTH = 20

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

export function credentialHint(value: string): string {
  return value.length >= CREDENTIAL_HINT_MIN_LENGTH
    ? `${value.slice(0, 4)}…${value.slice(-4)}`
    : `${value.length} characters`
}

export function credentialDisplayName(
  provider: string,
  name: string | null,
  type: string,
  mode: CredentialMode,
  environment: CredentialEnvironment,
): string {
  return `${[provider, name, type].filter((part) => part !== null).join('/')} (mode ${mode}, env ${environment})`
}

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
