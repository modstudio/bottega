import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addedGrokTrustHeadings, grokTrustHeadings } from './grok-trust.ts'

let home: string | null = null
afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true })
  home = null
})

test('passes scoped trust to doctor and spawn and records every new heading verbatim', () => {
  home = mkdtempSync(join(tmpdir(), 'orch-grok-trust-'))
  const env = { GROK_HOME: home }
  writeFileSync(join(home, 'trusted_folders.toml'),
    '[folders."/tmp/already-present"]\ntrusted = true\n')
  const before = grokTrustHeadings(env)
  writeFileSync(join(home, 'trusted_folders.toml'), [
    '[folders."/tmp/already-present"]', 'trusted = true',
    '[folders."/tmp/first observed"]', 'trusted = true',
    "[folders.'/tmp/second-observed']", 'trusted = true', '',
  ].join('\n'))
  expect(addedGrokTrustHeadings(before, grokTrustHeadings(env))).toEqual([
    '[folders."/tmp/first observed"]', "[folders.'/tmp/second-observed']",
  ])
})
