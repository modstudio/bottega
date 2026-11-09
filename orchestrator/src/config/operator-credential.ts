// concern: operator-credential
/** Resolves Bottega's own project-bound operator credentials with explicit env overrides. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { ConfigClientError, configClient } from '../../../shared/config-client.ts'
import type { ConfigEnvironment } from '../../../shared/config-directory.ts'
import type { OperatorCredentialIdentity } from '../../../shared/operator-credentials.ts'
import { projectByName } from '../project/projects.ts'
import { resolveProjectOperatorCredential } from './credential-service.ts'

type Dependencies = {
  env?: ConfigEnvironment
  resolve?: (
    identity: OperatorCredentialIdentity,
    signal?: AbortSignal,
  ) => Promise<string | undefined>
}

async function resolveStoredOperatorCredential(
  identity: OperatorCredentialIdentity,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const project = projectByName(PLATFORM_SLUG)
  if (!project) throw new Error(`no project ${PLATFORM_SLUG}`)
  const client = configClient(process.env, fetch, undefined, signal)
  return resolveProjectOperatorCredential(project, identity, client)
}

/** Prefer one explicit process variable, then open the platform project's typed credential. */
export async function resolveOperatorCredential(
  identity: OperatorCredentialIdentity,
  overrideVariable: string,
  signal?: AbortSignal,
  dependencies: Dependencies = {},
): Promise<string | undefined> {
  const override = (dependencies.env ?? process.env)[overrideVariable]
  if (override) return override
  try {
    return await (dependencies.resolve ?? resolveStoredOperatorCredential)(identity, signal)
  } catch (error) {
    if (error instanceof ConfigClientError && error.reason === 'not-configured') return undefined
    throw error
  }
}
