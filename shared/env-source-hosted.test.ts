import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from './brand.ts'
import { ConfigClientError } from './config-client.ts'
import { readEnvValuesWithHosted } from './env-source.ts'

test('local precedence wins and hosted receives only unresolved names', async () => {
  const root = mkdtempSync(join(tmpdir(), 'env-hosted-'))
  const harness = join(root, 'harness.env')
  const platformValue = `from-${PLATFORM_SLUG}`
  writeFileSync(harness, 'HARNESS=from-harness\n')
  writeFileSync(join(root, `${PLATFORM_SLUG}.env`), `FILE=${platformValue}\n`)
  let requested: readonly string[] = []
  const values = await readEnvValuesWithHosted(
    ['PROCESS', 'FILE', 'HARNESS', 'HOSTED'],
    { PROCESS: 'from-process', BOTTEGA_CONFIG_HOME: root, BOTTEGA_HARNESS_ENV_FILE: harness },
    async (names) => {
      requested = names
      return { HOSTED: 'from-hosted' }
    },
  )
  expect(requested).toEqual(['HOSTED'])
  expect(values).toEqual({
    PROCESS: 'from-process',
    FILE: platformValue,
    HARNESS: 'from-harness',
    HOSTED: 'from-hosted',
  })
})

test('not configured is absent while a configured failure refuses', async () => {
  const env = {
    BOTTEGA_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'env-hosted-')),
    BOTTEGA_HARNESS_ENV_FILE: '',
  }
  await expect(
    readEnvValuesWithHosted(['TOKEN'], env, async () => {
      throw new ConfigClientError('not-configured', '/v1/config')
    }),
  ).resolves.toEqual({ TOKEN: undefined })
  await expect(
    readEnvValuesWithHosted(['TOKEN'], env, async () => {
      throw new ConfigClientError('unreachable', '/v1/config/secrets/TOKEN')
    }),
  ).rejects.toMatchObject({ reason: 'unreachable' })
})
