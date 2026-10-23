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

type EndpointKeyRow = {
  baseUrl?: string | null
  apiKeySecret?: string | null
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

/** Resolve only at launch; the plaintext is returned solely for the child environment. */
export async function resolveEndpointApiKeyEnv(
  row: EndpointKeyRow,
  resolver: typeof readEnvValuesWithHosted = readEnvValuesWithHosted,
  options: {
    sleep?: (delayMs: number) => Promise<void>
    exhaustedRetryCommand?: string
  } = {},
): Promise<Record<string, string>> {
  const name = row.apiKeySecret?.trim() || null
  const resolved = name
    ? await resolveNamedEndpointApiKey(
        name,
        resolver,
        options.sleep ?? Bun.sleep,
        options.exhaustedRetryCommand ?? RUN_RETRY_REMEDY,
      )
    : undefined
  const decision = decideEndpointApiKey(row, resolved)
  if (!decision.ok) throw new Error(decision.refusal)
  return decision.env
}
