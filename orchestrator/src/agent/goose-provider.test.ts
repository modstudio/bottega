import { expect, test } from 'bun:test'
import { gooseProviderFile } from './goose-provider.ts'

test('a Goose provider file carries endpoint, model, context, credential, and request settings', () => {
  const file = gooseProviderFile({
    name: 'or-deepseek-v41-flash',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'deepseek/deepseek-v4.1-flash:floor',
    contextLimit: 128_000,
    requestSettings: {
      provider: { order: ['Relace'], ignore: ['Morph'], allow_fallbacks: true },
      reasoning: { effort: 'low' },
    },
  })

  expect(file?.name).toBe('or-deepseek-v41-flash')
  expect(JSON.parse(file!.content)).toEqual({
    name: 'or-deepseek-v41-flash',
    engine: 'openai',
    display_name: 'or-deepseek-v41-flash',
    api_key_env: 'OPENAI_API_KEY',
    base_url: 'https://openrouter.ai/api/v1',
    models: [
      {
        name: 'deepseek/deepseek-v4.1-flash:floor',
        context_limit: 128_000,
        request_params: {
          provider: { order: ['Relace'], ignore: ['Morph'], allow_fallbacks: true },
          reasoning: { effort: 'low' },
        },
      },
    ],
  })
})

test('a Goose row without request settings needs no provider file', () => {
  expect(
    gooseProviderFile({
      name: 'plain-goose',
      baseUrl: 'https://example.test/v1',
      model: 'fixture',
      contextLimit: 128_000,
      requestSettings: null,
    }),
  ).toBeNull()
})
