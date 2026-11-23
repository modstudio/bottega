import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gateStoreSource, withMainGateFactsSnapshot } from '../../scripts/branch-store.ts'
import { GATE_FACTS_ENV, parseGateFacts } from './gate-facts.ts'

test('selects the existing path for every compatible store kind and refuses unavailable ahead facts', () => {
  expect(gateStoreSource('current', false)).toEqual({ kind: 'existing', storeKind: 'current' })
  expect(gateStoreSource('behind', false)).toEqual({ kind: 'existing', storeKind: 'behind' })
  expect(gateStoreSource('absent', false)).toEqual({ kind: 'existing', storeKind: 'absent' })
  expect(gateStoreSource('ahead', true)).toEqual({ kind: 'gate-facts' })
  expect(gateStoreSource('ahead', false)).toEqual({ kind: 'refuse' })
})

test('refuses a snapshot format newer than the branch understands', () => {
  expect(() =>
    parseGateFacts(
      JSON.stringify({ formatVersion: 2, migrationVersion: 1, projects: [], docs: [] }),
    ),
  ).toThrow('unknown gate-facts format version 2')
})

test('worker gate consumes the dispatcher snapshot without spawning the main binary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-facts-supplied-'))
  const path = join(dir, 'facts.json')
  const previous = process.env[GATE_FACTS_ENV]
  try {
    writeFileSync(
      path,
      JSON.stringify({ formatVersion: 1, migrationVersion: 1, projects: [], docs: [] }),
    )
    process.env[GATE_FACTS_ENV] = path
    expect(
      withMainGateFactsSnapshot(
        'ahead',
        dir,
        () => 'unavailable',
        (snapshot) => snapshot.path,
      ),
    ).toBe(path)
  } finally {
    if (previous === undefined) delete process.env[GATE_FACTS_ENV]
    else process.env[GATE_FACTS_ENV] = previous
    rmSync(dir, { recursive: true, force: true })
  }
})
