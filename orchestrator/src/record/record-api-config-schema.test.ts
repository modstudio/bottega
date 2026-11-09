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
    { name: 'backup' },
    { projectId: id },
  ])
    expect(configSecretPutBody.safeParse({ ...base, ...fields }).success).toBe(false)

  expect(configSecretPutBody.safeParse(base).success).toBe(true)
  expect(
    configSecretPutBody.safeParse({
      ...base,
      environment: 'local',
      projectId: id,
      provider: 'openrouter',
      type: 'api-key',
      hint: 'open…hint',
      mode: 'default',
    }).success,
  ).toBe(true)
  expect(
    configSecretPutBody.safeParse({
      ...base,
      environment: 'production',
      provider: 'openrouter',
      type: 'api-key',
      hint: 'open…hint',
      mode: 'default',
    }).success,
  ).toBe(false)
  expect(
    configSecretPutBody.safeParse({
      ...base,
      environment: 'local',
      provider: 'aws',
      name: 'not_valid',
      type: 'access-key',
      hint: 'aws…hint',
      mode: 'default',
    }).success,
  ).toBe(false)
  expect(
    configSecretPutBody.safeParse({
      ...base,
      environment: 'local',
      provider: 'openrouter',
      type: 'api-key',
      hint: 'open…hint',
      mode: 'default',
      reachSpaceIds: [id],
    }).success,
  ).toBe(true)
})

test('config secret writes preserve absent reach separately from explicit all reach', () => {
  const absent = configSecretPutBody.parse(base)
  const all = configSecretPutBody.parse({ ...base, reachSpaceIds: null })
  expect(Object.hasOwn(absent, 'reachSpaceIds')).toBe(false)
  expect(all.reachSpaceIds).toBeNull()
})
