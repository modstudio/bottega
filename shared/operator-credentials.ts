// concern: operator-credentials
/** Canonical identities, overrides, and operator commands for Bottega's own credentials. */

import { PLATFORM_SLUG } from './brand.ts'
import { type CredentialMetadataFields, credentialIdentityPath } from './credential.ts'
import { RECORD_MIGRATE_SECRET_NAME } from './record-migrate-secret.ts'

export type OperatorCredentialIdentity = Pick<
  CredentialMetadataFields,
  'provider' | 'name' | 'type'
>

export type OperatorCredentialDefinition = {
  identity: OperatorCredentialIdentity
  overrideVariable: string
}

export const RECORD_MIGRATE_OPERATOR_CREDENTIAL = {
  identity: { provider: 'postgres', name: 'owner', type: 'url' },
  overrideVariable: RECORD_MIGRATE_SECRET_NAME,
} as const satisfies OperatorCredentialDefinition

export const FLY_METRICS_OPERATOR_CREDENTIAL = {
  identity: { provider: 'fly', name: 'metrics', type: 'token' },
  overrideVariable: 'BOTTEGA_FLY_METRICS_TOKEN',
} as const satisfies OperatorCredentialDefinition

export const RECORD_REHEARSAL_OPERATOR_CREDENTIAL = {
  identity: { provider: 'fly', name: 'rehearsal', type: 'token' },
  overrideVariable: 'BOTTEGA_RECORD_REHEARSAL_FLY_TOKEN',
} as const satisfies OperatorCredentialDefinition

export function operatorCredentialSetCommand(definition: OperatorCredentialDefinition): string {
  const { provider, name, type } = definition.identity
  return `${PLATFORM_SLUG} credential set ${credentialIdentityPath(provider, name, type)} --project ${PLATFORM_SLUG}`
}

export function operatorCredentialResolveCommand(definition: OperatorCredentialDefinition): string {
  const { provider, name, type } = definition.identity
  return `${PLATFORM_SLUG} credential resolve ${credentialIdentityPath(provider, name, type)} --project ${PLATFORM_SLUG}`
}
