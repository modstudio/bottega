import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { resolveHostedUrl } from './hosted-url.ts'

const prior = {
  configHome: process.env.BOTTEGA_CONFIG_HOME,
  harnessFile: process.env.BOTTEGA_HARNESS_ENV_FILE,
  hostedUrl: process.env.HUB_HOSTED_URL,
}
let temporaryRoot: string | undefined

afterEach(() => {
  if (prior.configHome === undefined) delete process.env.BOTTEGA_CONFIG_HOME
  else process.env.BOTTEGA_CONFIG_HOME = prior.configHome
  if (prior.harnessFile === undefined) delete process.env.BOTTEGA_HARNESS_ENV_FILE
  else process.env.BOTTEGA_HARNESS_ENV_FILE = prior.harnessFile
  if (prior.hostedUrl === undefined) delete process.env.HUB_HOSTED_URL
  else process.env.HUB_HOSTED_URL = prior.hostedUrl
  if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true })
  temporaryRoot = undefined
})

test('hosted URL resolves a value present only in the platform config file', () => {
  temporaryRoot = mkdtempSync(join(tmpdir(), `${PLATFORM_SLUG}-hosted-url-`))
  process.env.BOTTEGA_CONFIG_HOME = temporaryRoot
  process.env.BOTTEGA_HARNESS_ENV_FILE = ''
  delete process.env.HUB_HOSTED_URL
  writeFileSync(
    join(temporaryRoot, `${PLATFORM_SLUG}.env`),
    'HUB_HOSTED_URL=https://hub.example.test\n',
  )

  expect(resolveHostedUrl()).toBe('https://hub.example.test')
})
