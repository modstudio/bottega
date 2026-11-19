import { expect, test } from 'bun:test'
import { type ConfigClient, ConfigClientError } from '../../../shared/config-client.ts'
import {
  type ExpectedSecret,
  isWrittenSecretRow,
  verifySecretWrite,
} from './secret-write-verification.ts'

const expected: ExpectedSecret = {
  key: 'TOKEN',
  scope: 'user',
  environment: 'default',
  rowVersion: 2,
  dekId: 'dek-2',
}

const read = { ...expected }

test('written secret row comparison matches and rejects each single-field mismatch', () => {
  expect(isWrittenSecretRow(read, expected)).toBe(true)
  for (const [field, value] of [
    ['key', 'OTHER'],
    ['scope', 'space'],
    ['environment', 'remote'],
    ['rowVersion', 3],
    ['dekId', 'dek-3'],
  ] as const) {
    expect(isWrittenSecretRow({ ...read, [field]: value }, expected), field).toBe(false)
  }
})

test('write verification uses the caller repair and names a project destination', async () => {
  const client = {
    getSecret: async () => {
      throw new ConfigClientError('response', '/v1/config/secrets/TOKEN', 404)
    },
  } as unknown as ConfigClient

  await expect(
    verifySecretWrite(
      client,
      expected,
      { destinationSpaceId: 'space-pinned', projectId: 'project-alpha' },
      'bottega credential set openrouter/api-key --project alpha',
    ),
  ).rejects.toThrow(
    'wrote TOKEN in project project-alpha in space space-pinned but could not read that row back from project project-alpha in space space-pinned; verify record access, then retry `bottega credential set openrouter/api-key --project alpha`',
  )
})
