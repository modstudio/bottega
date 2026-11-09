// concern: credential-presentation
/** Presents typed credential identities for the orchestrator's credential commands. */

import {
  CREDENTIAL_BINDINGS,
  CREDENTIAL_PAYERS,
  type CredentialBinding,
  type CredentialEnvironment,
  type CredentialMode,
  type CredentialPayer,
  credentialIdentityPath,
} from '../../../shared/credential.ts'

const CREDENTIAL_HINT_MIN_LENGTH = 20

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
  return `${credentialIdentityPath(provider, name, type)} (mode ${mode}, env ${environment})`
}

export function credentialSlot(
  payer: CredentialPayer,
  projectId: string | null,
  account = false,
): string {
  return `${payer}@${account ? 'account' : projectId ? 'project' : 'space'}`
}

export function parseCredentialSlot(
  value: string,
): { payer: CredentialPayer; binding: CredentialBinding } | null {
  for (const payer of CREDENTIAL_PAYERS)
    for (const binding of CREDENTIAL_BINDINGS)
      if (value === `${payer}@${binding}`) return { payer, binding }
  return null
}
