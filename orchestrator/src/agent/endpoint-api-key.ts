// concern: endpoint-api-key
/** Decides endpoint authentication from an agent's stored reference and resolves that reference at launch. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { readEnvValuesWithHosted } from '../../../shared/env-source.ts'
import { secretResolutionFailure } from '../../../shared/secret-resolution-failure.ts'

type EndpointKeyRow = {
  baseUrl?: string | null
  apiKeySecret?: string | null
}

export type EndpointApiKeyDecision =
  | { ok: true; env: Record<string, string> }
  | { ok: false; refusal: string }

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
): Promise<Record<string, string>> {
  const name = row.apiKeySecret?.trim() || null
  let resolved: string | undefined
  if (name) {
    try {
      resolved = (await resolver([name]))[name]
    } catch (error) {
      const failure = secretResolutionFailure(error)
      if (failure)
        throw new Error(`agent endpoint API key ${name} could not be resolved: ${failure}`)
      throw error
    }
  }
  const decision = decideEndpointApiKey(row, resolved)
  if (!decision.ok) throw new Error(decision.refusal)
  return decision.env
}
