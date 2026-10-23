import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { CONFIG_HOME_ENV } from '../../../shared/config-directory.ts'
import { rewriteRecordBindingEnv, useHostedRecord } from './record-use.ts'

const addresses = {
  recordApiUrl: 'https://api.example.test',
  hubHostedUrl: 'https://app.example.test',
}

test('writes both addresses into an absent file', () => {
  expect(rewriteRecordBindingEnv('', addresses)).toBe(
    'BOTTEGA_RECORD_API_URL=https://api.example.test\nBOTTEGA_HOSTED_URL=https://app.example.test\n',
  )
})

test('appends both addresses after unrelated keys', () => {
  expect(rewriteRecordBindingEnv('OTHER=kept\n', addresses)).toBe(
    'OTHER=kept\nBOTTEGA_RECORD_API_URL=https://api.example.test\nBOTTEGA_HOSTED_URL=https://app.example.test\n',
  )
})

test('replaces old address values', () => {
  expect(
    rewriteRecordBindingEnv(
      'BOTTEGA_RECORD_API_URL=https://old-api.test\nBOTTEGA_HOSTED_URL=https://old-app.test\n',
      addresses,
    ),
  ).toBe(
    'BOTTEGA_RECORD_API_URL=https://api.example.test\nBOTTEGA_HOSTED_URL=https://app.example.test\n',
  )
})

test('preserves comments, blank lines, and unrelated lines byte for byte', () => {
  expect(
    rewriteRecordBindingEnv(
      '# heading\r\n\r\nKEEP = untouched # exactly\r\nBOTTEGA_RECORD_API_URL=old\r\n# tail\r\n',
      addresses,
    ),
  ).toBe(
    '# heading\r\n\r\nKEEP = untouched # exactly\r\nBOTTEGA_RECORD_API_URL=https://api.example.test\r\n# tail\r\nBOTTEGA_HOSTED_URL=https://app.example.test\r\n',
  )
})

test('discovers addresses, writes the resolved config file, and warns about process overrides', async () => {
  const root = mkdtempSync(join(tmpdir(), 'record-use-'))
  const output: string[] = []
  const warnings: string[] = []
  let requested = ''
  try {
    await useHostedRecord(
      'https://entry.example.test/',
      { log: (message) => output.push(message), warn: (message) => warnings.push(message) },
      {
        [CONFIG_HOME_ENV]: root,
        BOTTEGA_RECORD_API_URL: 'https://shell.example.test',
      },
      async (input) => {
        requested = String(input)
        return Response.json(addresses)
      },
    )
    expect(requested).toBe('https://entry.example.test/client-config')
    expect(readFileSync(join(root, `${PLATFORM_SLUG}.env`), 'utf8')).toBe(
      'BOTTEGA_RECORD_API_URL=https://api.example.test\nBOTTEGA_HOSTED_URL=https://app.example.test\n',
    )
    expect(output.at(-1)).toBe(`next: ${PLATFORM_SLUG} record sign-in --email <email>`)
    expect(warnings).toEqual([
      'BOTTEGA_RECORD_API_URL=https://shell.example.test from the environment wins for this shell',
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('appends discovery to the address path with URL path operations', async () => {
  let requested = ''
  const root = mkdtempSync(join(tmpdir(), 'record-use-path-'))
  try {
    await useHostedRecord(
      'https://entry.example.test/record/',
      { log: () => undefined, warn: () => undefined },
      { [CONFIG_HOME_ENV]: root },
      async (input) => {
        requested = String(input)
        return Response.json(addresses)
      },
    )
    expect(requested).toBe('https://entry.example.test/record/client-config')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('refuses malformed discovery with the address it tried and the reason', async () => {
  await expect(
    useHostedRecord(
      'https://entry.example.test',
      { log: () => undefined, warn: () => undefined },
      { [CONFIG_HOME_ENV]: '/unused' },
      async () => Response.json({ hubHostedUrl: 'not a URL' }),
    ),
  ).rejects.toThrow(
    'cannot use hosted record at https://entry.example.test: the discovery response did not contain valid recordApiUrl and hubHostedUrl addresses',
  )
})
