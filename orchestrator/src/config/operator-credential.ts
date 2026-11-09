// concern: operator-credential
/** Resolves Bottega's own project-bound operator credentials with explicit env overrides. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { ConfigClientError, configClient } from '../../../shared/config-client.ts'
import type { CredentialMetadataFields } from '../../../shared/credential.ts'
import { resolveHostedCredentialValue } from '../../../shared/credential-value.ts'
import { projectByName } from '../project/projects.ts'
import { projectCredentialAddress } from './credential-service.ts'

export type OperatorCredentialIdentity = Pick<
  CredentialMetadataFields,
  'provider' | 'name' | 'type'
>

type Dependencies = {
  env?: Record<string, string | undefined>
  resolve?: (identity: OperatorCredentialIdentity) => Promise<string | undefined>
}

async function resolveStoredOperatorCredential(
  identity: OperatorCredentialIdentity,
): Promise<string | undefined> {
  const project = projectByName(PLATFORM_SLUG)
  if (!project) throw new Error(`no project ${PLATFORM_SLUG}`)
  const client = configClient()
  const address = {
    ...(await projectCredentialAddress(project, identity.provider, client)),
    ...identity,
  }
  const result = await resolveHostedCredentialValue(address, client)
  return result.kind === 'refused' ? undefined : result.value
}

/** Prefer one explicit process variable, then open the platform project's typed credential. */
export async function resolveOperatorCredential(
  identity: OperatorCredentialIdentity,
  overrideVariable: string,
  dependencies: Dependencies = {},
): Promise<string | undefined> {
  const override = (dependencies.env ?? process.env)[overrideVariable]
  if (override) return override
  try {
    return await (dependencies.resolve ?? resolveStoredOperatorCredential)(identity)
  } catch (error) {
    if (error instanceof ConfigClientError && error.reason === 'not-configured') return undefined
    throw error
  }
}
