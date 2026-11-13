import { expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_HOME_ENV } from './config-directory.ts'
import { readRememberedTrustLogHead, writeRememberedTrustLogHead } from './trust-log-head.ts'

test('remembered trust log heads round-trip as owner-only lowercase hex', () => {
  const root = mkdtempSync(join(tmpdir(), 'trust-log-head-'))
  const env = { [CONFIG_HOME_ENV]: root }
  const head = new Uint8Array(32).fill(0xab)
  writeRememberedTrustLogHead('space-id', head, env)
  const path = join(root, 'trust-log-heads', 'space-id')
  expect(readFileSync(path, 'utf8')).toBe(`${'ab'.repeat(32)}\n`)
  expect(readRememberedTrustLogHead('space-id', env)).toEqual(head)
})

test('remembered trust log heads refuse malformed or over-broad files', () => {
  const root = mkdtempSync(join(tmpdir(), 'trust-log-head-bad-'))
  const env = { [CONFIG_HOME_ENV]: root }
  writeRememberedTrustLogHead('space-id', new Uint8Array(32), env)
  const path = join(root, 'trust-log-heads', 'space-id')
  writeFileSync(path, `${'AA'.repeat(32)}\n`)
  expect(() => readRememberedTrustLogHead('space-id', env)).toThrow('lowercase hex')
  writeFileSync(path, `${'00'.repeat(32)}\n`)
  chmodSync(path, 0o644)
  expect(() => readRememberedTrustLogHead('space-id', env)).toThrow(
    'file permissions must be no wider than 0600',
  )
})
