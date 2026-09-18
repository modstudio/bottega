import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_HOME_ENV, HARNESS_ENV_FILE_ENV } from './config-directory.ts'
import { readEnvValues, resolveEnvValues } from './env-source.ts'

test('process and platform env sources take precedence in that order', () => {
  expect(
    resolveEnvValues(
      ['EVERYWHERE', 'FILES_ONLY'],
      { EVERYWHERE: 'process' },
      {
        platform: 'EVERYWHERE=platform\nFILES_ONLY=platform\n',
        harness: 'EVERYWHERE=harness\nFILES_ONLY=harness\n',
      },
    ),
  ).toEqual({ EVERYWHERE: 'process', FILES_ONLY: 'platform' })
})

test('an empty harness setting disables that source', () => {
  const root = mkdtempSync(join(tmpdir(), 'env-source-disabled-'))
  try {
    const harness = join(root, 'harness.env')
    writeFileSync(harness, 'HARNESS_ONLY=secret\n')
    expect(
      readEnvValues(['HARNESS_ONLY'], {
        HOME: root,
        [CONFIG_HOME_ENV]: join(root, 'missing-config'),
        [HARNESS_ENV_FILE_ENV]: '',
      }),
    ).toEqual({ HARNESS_ONLY: undefined })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an env file that exists but cannot be read refuses and names its path', () => {
  const root = mkdtempSync(join(tmpdir(), 'env-source-unreadable-'))
  try {
    const unreadable = join(root, 'not-a-file')
    mkdirSync(unreadable)
    expect(() =>
      readEnvValues(['VALUE'], {
        HOME: root,
        [CONFIG_HOME_ENV]: join(root, 'missing-config'),
        [HARNESS_ENV_FILE_ENV]: unreadable,
      }),
    ).toThrow(`cannot read environment file ${unreadable}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
