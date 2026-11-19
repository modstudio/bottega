import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { type ConfigClient, ConfigClientError } from '../../../shared/config-client.ts'
import { isWrittenConfigRow, verifyConfigWrite } from './config-write-verification.ts'

const expected = {
  key: 'autonomy.preset',
  environment: 'default',
  scope: 'space' as const,
  value: 'autonomous',
  rowVersion: 2,
  updatedAt: '2026-11-18T12:00:00.000Z',
}

test('written config row comparison requires the reported value and row version', () => {
  expect(isWrittenConfigRow(expected, expected)).toBe(true)
  expect(isWrittenConfigRow({ ...expected, value: 'manual' }, expected)).toBe(false)
  expect(isWrittenConfigRow({ ...expected, rowVersion: 3 }, expected)).toBe(false)
  expect(isWrittenConfigRow(null, expected)).toBe(false)
})

test('named-space config write verification refuses a missing read-back with its repair command', async () => {
  const client = {
    getEntry: async () => {
      throw new ConfigClientError('response', '/v1/config/entries/autonomy.preset', 404)
    },
  } as unknown as ConfigClient
  const remedy = `${PLATFORM_SLUG} machine config set autonomy.preset autonomous --space other`

  await expect(
    verifyConfigWrite(client, expected, { destinationSpaceId: 'space-other' }, remedy),
  ).rejects.toThrow(`verify record access, then retry \`${remedy}\``)
})
