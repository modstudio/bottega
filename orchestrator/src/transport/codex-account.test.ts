import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { currentQuotaAccountId, parseCodexAccountId, readCodexAccountId } from './codex-account.ts'

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
    expect(currentQuotaAccountId('codex', { CODEX_HOME: root }, '/unused')).toBe('account-fixture')
    expect(currentQuotaAccountId('claude', { CODEX_HOME: root }, '/unused')).toBeNull()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Codex quota account falls back to the declared directory under home', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-codex-account-home-'))
  const codexHome = join(root, '.codex')
  mkdirSync(codexHome, { recursive: true })
  writeFileSync(
    join(codexHome, 'auth.json'),
    JSON.stringify({ tokens: { account_id: 'account-from-home' } }),
  )
  try {
    expect(currentQuotaAccountId('codex', {}, root)).toBe('account-from-home')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
