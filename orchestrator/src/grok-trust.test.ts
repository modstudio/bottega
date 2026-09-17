import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addedGrokTrustHeadings, grokTrustHeadings, withoutGrokTrustHeading } from './grok-trust.ts'

let home: string | null = null
afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true })
  home = null
})

test('trust editing removes one exact table and leaves every other byte unchanged', () => {
  const content = '# lead\r\n[folders."/a"]\r\ntrusted = true\r\n[folders."/b"]\ntrusted=false\n'
  expect(withoutGrokTrustHeading(content, '[folders."/a"]')).toBe(
    '# lead\r\n[folders."/b"]\ntrusted=false\n',
  )
  expect(withoutGrokTrustHeading(content, '[folders."/missing"]')).toBeNull()
})

test('passes scoped trust to doctor and spawn and records every new heading verbatim', () => {
  home = mkdtempSync(join(tmpdir(), 'orch-grok-trust-'))
  const env = { GROK_HOME: home }
  writeFileSync(
    join(home, 'trusted_folders.toml'),
    '[folders."/tmp/already-present"]\ntrusted = true\n',
  )
  const before = grokTrustHeadings(env)
  writeFileSync(
    join(home, 'trusted_folders.toml'),
    [
      '[folders."/tmp/already-present"]',
      'trusted = true',
      '[folders."/tmp/first observed"]',
      'trusted = true',
      "[folders.'/tmp/second-observed']",
      'trusted = true',
      '',
    ].join('\n'),
  )
  expect(addedGrokTrustHeadings(before, grokTrustHeadings(env))).toEqual([
    '[folders."/tmp/first observed"]',
    "[folders.'/tmp/second-observed']",
  ])
})
