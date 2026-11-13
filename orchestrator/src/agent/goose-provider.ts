// concern: goose-provider
/** Builds Goose custom-provider configuration without touching the filesystem. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'

/** OpenRouter request parameters an agent row carries into its Goose provider. */
export type RequestSettings = Record<string, unknown>

export type GooseProviderFile = { name: string; content: string }

export function gooseProviderFile(input: {
  name: string
  baseUrl: string | null | undefined
  model: string
  contextLimit: number | null
  requestSettings: RequestSettings | null | undefined
}): GooseProviderFile | null {
  if (!input.requestSettings) return null
  if (!input.baseUrl) {
    throw new Error(
      `Goose custom provider ${input.name} has no base URL; set one with ${PLATFORM_SLUG} agent set ${input.name} --base-url <url>`,
    )
  }
  if (!input.model) throw new Error(`Goose custom provider ${input.name} has no model`)
  if (input.contextLimit === null) {
    throw new Error(`Goose custom provider ${input.name} has no launch context limit`)
  }
  return {
    name: input.name,
    content: JSON.stringify({
      name: input.name,
      engine: 'openai',
      display_name: input.name,
      api_key_env: 'OPENAI_API_KEY',
      base_url: input.baseUrl,
      models: [
        {
          name: input.model,
          context_limit: input.contextLimit,
          request_params: input.requestSettings,
        },
      ],
    }),
  }
}
