import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from './brand.ts'
import { CONFIG_HOME_ENV, HARNESS_ENV_FILE_ENV } from './config-directory.ts'
import { readEnvValues } from './env-source.ts'

test('process and platform env sources take precedence in that order', () => {
  const root = mkdtempSync(join(tmpdir(), 'env-source-precedence-'))
  try {
    const config = join(root, 'config')
    const harness = join(root, 'harness.env')
    mkdirSync(config)
    writeFileSync(
      join(config, `${PLATFORM_SLUG}.env`),
      'EVERYWHERE=platform\nFILES_ONLY=platform\n',
    )
    writeFileSync(harness, 'EVERYWHERE=harness\nFILES_ONLY=harness\n')
    expect(
      readEnvValues(['EVERYWHERE', 'FILES_ONLY'], {
        EVERYWHERE: 'process',
        HOME: root,
        [CONFIG_HOME_ENV]: config,
        [HARNESS_ENV_FILE_ENV]: harness,
      }),
    ).toEqual({ EVERYWHERE: 'process', FILES_ONLY: 'platform' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a value present only in the harness source resolves from it', () => {
  const root = mkdtempSync(join(tmpdir(), 'env-source-harness-'))
  try {
    const harness = join(root, 'harness.env')
    writeFileSync(harness, 'HARNESS_ONLY=harness\n')
    expect(
      readEnvValues(['HARNESS_ONLY'], {
        HOME: root,
        [CONFIG_HOME_ENV]: join(root, 'missing-config'),
        [HARNESS_ENV_FILE_ENV]: harness,
      }),
    ).toEqual({ HARNESS_ONLY: 'harness' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the child environment uses parseEnv values without shell expansion', () => {
  const root = mkdtempSync(join(tmpdir(), 'env-source-literal-'))
  try {
    const config = join(root, 'config')
    mkdirSync(config)
    writeFileSync(join(config, `${PLATFORM_SLUG}.env`), 'BASE=/root\nVALUE=$BASE/token\n')
    expect(
      readEnvValues(['BASE', 'VALUE'], {
        HOME: root,
        [CONFIG_HOME_ENV]: config,
        [HARNESS_ENV_FILE_ENV]: '',
      }),
    ).toEqual({ BASE: '/root', VALUE: '$BASE/token' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
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

test('an unreadable env file is not consulted when process environment answers', () => {
  const root = mkdtempSync(join(tmpdir(), 'env-source-process-'))
  try {
    const unreadable = join(root, 'not-a-file')
    mkdirSync(unreadable)
    expect(
      readEnvValues(['VALUE'], {
        VALUE: 'process',
        [HARNESS_ENV_FILE_ENV]: unreadable,
      }),
    ).toEqual({ VALUE: 'process' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
