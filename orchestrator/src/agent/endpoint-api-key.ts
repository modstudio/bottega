// concern: endpoint-api-key
/** Decides endpoint authentication from an agent's stored reference and resolves that reference at launch. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { readEnvValuesWithHosted } from '../../../shared/env-source.ts'
import { RUN_RETRY_REMEDY } from '../../../shared/record-remedies.ts'
import {
  classifySecretResolutionFailure,
  isTransientSecretResolutionFailure,
  type SecretResolutionFailureClassification,
  secretResolutionFailure,
} from '../../../shared/secret-resolution-failure.ts'
import type { EffectiveBillingKey } from '../failure/failure.ts'
import type { ProjectAgentKeys } from '../project/project-agent-keys.ts'

type EndpointKeyRow = {
  baseUrl?: string | null
  apiKeySecret?: string | null
}

/** Pure policy: a project mapping replaces only the matching agent secret reference. */
export function decideEffectiveEndpointApiKey(
  agentSecretName: string | null | undefined,
  project?: { name: string; settings: { agentKeys?: ProjectAgentKeys } } | null,
): EffectiveBillingKey {
  const agentSecret = agentSecretName?.trim() || null
  if (!agentSecret) return { secretName: null, source: 'agent', projectName: null }
  const projectSecret = project?.settings.agentKeys?.[agentSecret]
  return projectSecret
    ? { secretName: projectSecret, source: 'project', projectName: project.name }
    : { secretName: agentSecret, source: 'agent', projectName: null }
}

/** Prepare one run's endpoint row and project-aware refusal context without resolving a value. */
export function effectiveEndpointApiKeyForRun<T extends EndpointKeyRow>(
  row: T,
  project?: { name: string; settings: { agentKeys?: ProjectAgentKeys } } | null,
): {
  row: T
  key: EffectiveBillingKey
  resolve(): Promise<Record<string, string>>
} {
  const key = decideEffectiveEndpointApiKey(row.apiKeySecret, project)
  const effectiveRow = { ...row, apiKeySecret: key.secretName }
  const options =
    key.source === 'project'
      ? { projectSecret: { project: project!.name, agentSecret: row.apiKeySecret!.trim() } }
      : {}
  return {
    row: effectiveRow,
    key,
    resolve: () => resolveEndpointApiKeyEnv(effectiveRow, undefined, options),
  }
}

export type EndpointApiKeyDecision =
  | { ok: true; env: Record<string, string> }
  | { ok: false; refusal: string }

export type EndpointApiKeyRetryDecision =
  | { retry: true; delayMs: number }
  | { retry: false; retriesExhausted: boolean }

export const ENDPOINT_API_KEY_RESOLUTION_MAX_ATTEMPTS = 3
/** Hosted slowness lasts seconds, so the retry window spans seconds rather than milliseconds. */
const ENDPOINT_API_KEY_RESOLUTION_INITIAL_RETRY_DELAY_MS = 2_000

/** Pure policy: retry only transient hosted failures, up to the endpoint-key attempt bound. */
export function decideEndpointApiKeyRetry(
  failure: SecretResolutionFailureClassification | null,
  attemptNumber: number,
): EndpointApiKeyRetryDecision {
  const transient = isTransientSecretResolutionFailure(failure)
  if (!transient || attemptNumber < 1) return { retry: false, retriesExhausted: false }
  if (attemptNumber >= ENDPOINT_API_KEY_RESOLUTION_MAX_ATTEMPTS)
    return { retry: false, retriesExhausted: true }
  return {
    retry: true,
    delayMs: ENDPOINT_API_KEY_RESOLUTION_INITIAL_RETRY_DELAY_MS * 2 ** (attemptNumber - 1),
  }
}

async function resolveNamedEndpointApiKey(
  name: string,
  resolver: typeof readEnvValuesWithHosted,
  sleep: (delayMs: number) => Promise<void>,
  exhaustedRetryCommand: string,
): Promise<string | undefined> {
  for (let attempt = 1; attempt <= ENDPOINT_API_KEY_RESOLUTION_MAX_ATTEMPTS; attempt += 1) {
    try {
      return (await resolver([name]))[name]
    } catch (error) {
      const retry = decideEndpointApiKeyRetry(classifySecretResolutionFailure(error), attempt)
      if (retry.retry) {
        await sleep(retry.delayMs)
        continue
      }
      const failure = secretResolutionFailure(error, {
        ...(retry.retriesExhausted ? { exhaustedRetryCommand } : {}),
      })
      if (failure)
        throw new Error(`agent endpoint API key ${name} could not be resolved: ${failure}`)
      throw error
    }
  }
}

/** Pure policy: preserve local endpoint auth unless the row explicitly names a resolved secret. */
export function decideEndpointApiKey(
  row: EndpointKeyRow,
  resolved: string | undefined,
): EndpointApiKeyDecision {
  const name = row.apiKeySecret?.trim() || null
  if (!name) return { ok: true, env: row.baseUrl ? { OPENAI_API_KEY: 'local' } : {} }
  if (resolved !== undefined) return { ok: true, env: { OPENAI_API_KEY: resolved } }
  return {
    ok: false,
    refusal:
      `agent endpoint API key ${name} could not be resolved\n` +
      `cleared by: ${PLATFORM_SLUG} machine config secret set ${name}`,
  }
}

/** Pure rendering policy for a declared project secret that cannot be used. */
function projectEndpointApiKeyRefusal(input: {
  projectName: string
  agentSecretName: string
  projectSecretName: string
  cause?: string
}): string {
  return (
    `project ${input.projectName} maps agent secret ${input.agentSecretName} to project secret ${input.projectSecretName}, but ${input.projectSecretName} could not be resolved` +
    `${input.cause ? `: ${input.cause}` : ''}\n` +
    `cleared by: ${PLATFORM_SLUG} machine config secret set ${input.projectSecretName}`
  )
}

/** Resolve only at launch; the plaintext is returned solely for the child environment. */
export async function resolveEndpointApiKeyEnv(
  row: EndpointKeyRow,
  resolver: typeof readEnvValuesWithHosted = readEnvValuesWithHosted,
  options: {
    sleep?: (delayMs: number) => Promise<void>
    exhaustedRetryCommand?: string
    projectSecret?: { project: string; agentSecret: string }
  } = {},
): Promise<Record<string, string>> {
  const name = row.apiKeySecret?.trim() || null
  let resolved: string | undefined
  try {
    resolved = name
      ? await resolveNamedEndpointApiKey(
          name,
          resolver,
          options.sleep ?? Bun.sleep,
          options.exhaustedRetryCommand ?? RUN_RETRY_REMEDY,
        )
      : undefined
  } catch (error) {
    if (!options.projectSecret) throw error
    throw new Error(
      projectEndpointApiKeyRefusal({
        projectName: options.projectSecret.project,
        agentSecretName: options.projectSecret.agentSecret,
        projectSecretName: name!,
        cause: String((error as Error)?.message ?? error),
      }),
    )
  }
  const decision = decideEndpointApiKey(row, resolved)
  if (!decision.ok) {
    if (options.projectSecret) {
      throw new Error(
        projectEndpointApiKeyRefusal({
          projectName: options.projectSecret.project,
          agentSecretName: options.projectSecret.agentSecret,
          projectSecretName: name!,
        }),
      )
    }
    throw new Error(decision.refusal)
  }
  return decision.env
}

export type EndpointApiKeyResolution =
  | { status: 'resolves' }
  | { status: 'unresolved' }
  | { status: 'could-not-check'; reason: string }

/** Check only whether a named secret resolves, without exposing its value to reporting callers. */
export async function endpointApiKeyResolves(
  name: string,
  resolver: typeof readEnvValuesWithHosted = readEnvValuesWithHosted,
): Promise<EndpointApiKeyResolution> {
  try {
    return (await resolver([name]))[name] !== undefined
      ? { status: 'resolves' }
      : { status: 'unresolved' }
  } catch (error) {
    const reason = secretResolutionFailure(error, { unreachableDiagnostic: null })
    if (!reason) throw error
    return { status: 'could-not-check', reason }
  }
}
