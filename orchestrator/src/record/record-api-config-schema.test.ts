import { expect, test } from 'bun:test'
import { configSecretPutBody } from './record-api-config-schema.ts'

const id = '01990000-0000-7000-8000-000000000001'
const base = {
  environment: 'default',
  scope: 'user',
  expectedRowVersion: null,
  dekId: id,
  envelope: 'AQ',
}

test('config secret writes require complete credential metadata', () => {
  for (const fields of [
    { provider: 'openrouter' },
    { provider: 'openrouter', type: null, hint: 'open…hint' },
    { projectId: id },
  ])
    expect(configSecretPutBody.safeParse({ ...base, ...fields }).success).toBe(false)

  expect(configSecretPutBody.safeParse(base).success).toBe(true)
  expect(
    configSecretPutBody.safeParse({
      ...base,
      projectId: id,
      provider: 'openrouter',
      type: 'api-key',
      hint: 'open…hint',
    }).success,
  ).toBe(true)
})
