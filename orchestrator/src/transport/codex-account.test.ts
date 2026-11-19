import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseCodexAccountId, readCodexAccountId } from './codex-account.ts'

test('Codex account parsing returns only tokens.account_id', () => {
  expect(parseCodexAccountId(JSON.stringify({ tokens: { account_id: 'account-fixture' } }))).toBe(
    'account-fixture',
  )
})

test('Codex account parsing returns null for missing file, field, and malformed JSON', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-codex-account-'))
  try {
    expect(readCodexAccountId(root)).toBeNull()
    expect(parseCodexAccountId(JSON.stringify({ tokens: {} }))).toBeNull()
    expect(parseCodexAccountId('{malformed')).toBeNull()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Codex account reader does not expose token text', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-codex-account-'))
  mkdirSync(root, { recursive: true })
  writeFileSync(
    join(root, 'auth.json'),
    JSON.stringify({
      tokens: {
        account_id: 'account-fixture',
        access_token: 'fake_dev_2482_access_token',
        refresh_token: 'fake_dev_2482_refresh_token',
        id_token: 'fake_dev_2482_id_token',
      },
    }),
  )
  try {
    const result = readCodexAccountId(root)
    expect(result).toBe('account-fixture')
    expect(JSON.stringify(result)).not.toContain('fake_dev_2482_')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
