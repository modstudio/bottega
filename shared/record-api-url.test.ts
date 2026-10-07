import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_HOME_ENV, HARNESS_ENV_FILE_ENV } from './config-directory.ts'
import { resolveRecordApiUrl } from './record-api-url.ts'

test('the process record endpoint wins over configured files', () => {
  const root = mkdtempSync(join(tmpdir(), 'record-api-url-process-'))
  try {
    const config = join(root, 'config')
    const harness = join(root, 'harness.env')
    mkdirSync(config)
    writeFileSync(harness, 'ORCH_RECORD_API_URL=https://file.example.test\n')

    expect(
      resolveRecordApiUrl({
        ORCH_RECORD_API_URL: 'https://process.example.test',
        [CONFIG_HOME_ENV]: config,
        [HARNESS_ENV_FILE_ENV]: harness,
      }),
    ).toBe('https://process.example.test')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the record endpoint falls back to configured files', () => {
  const root = mkdtempSync(join(tmpdir(), 'record-api-url-file-'))
  try {
    const config = join(root, 'config')
    const harness = join(root, 'harness.env')
    mkdirSync(config)
    writeFileSync(harness, 'ORCH_RECORD_API_URL=https://file.example.test\n')

    expect(
      resolveRecordApiUrl({
        [CONFIG_HOME_ENV]: config,
        [HARNESS_ENV_FILE_ENV]: harness,
      }),
    ).toBe('https://file.example.test')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the record endpoint is undefined when no source provides it', () => {
  const root = mkdtempSync(join(tmpdir(), 'record-api-url-missing-'))
  try {
    expect(
      resolveRecordApiUrl({
        [CONFIG_HOME_ENV]: join(root, 'config'),
        [HARNESS_ENV_FILE_ENV]: '',
      }),
    ).toBeUndefined()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
