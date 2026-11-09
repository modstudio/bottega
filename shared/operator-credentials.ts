// concern: operator-credentials
/** Canonical identities, overrides, and operator commands for Bottega's own credentials. */

import { PLATFORM_SLUG } from './brand.ts'
import type { CredentialMetadataFields } from './credential.ts'
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

export function operatorCredentialPath(identity: OperatorCredentialIdentity): string {
  return [identity.provider, identity.name, identity.type].filter((part) => part !== null).join('/')
}

export function operatorCredentialSetCommand(definition: OperatorCredentialDefinition): string {
  return `${PLATFORM_SLUG} credential set ${operatorCredentialPath(definition.identity)} --project ${PLATFORM_SLUG}`
}

export function operatorCredentialResolveCommand(definition: OperatorCredentialDefinition): string {
  return `${PLATFORM_SLUG} credential resolve ${operatorCredentialPath(definition.identity)} --project ${PLATFORM_SLUG}`
}
