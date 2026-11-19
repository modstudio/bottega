import { expect, test } from 'bun:test'
import { gateStoreSource } from '../../scripts/branch-store.ts'
import { parseGateFacts } from './gate-facts.ts'

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
