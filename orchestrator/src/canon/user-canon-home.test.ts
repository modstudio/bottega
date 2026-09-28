import { describe, expect, test } from 'bun:test'
import {
  decideUserCanonHydration,
  mapUserCanonHomePath,
  mapUserCanonPath,
  stripUserCanonManagedMarker,
  USER_CANON_HOME_MAPPINGS,
  USER_CANON_MANAGED_MARKER,
  userCanonHomeImportDeletionSlugs,
} from './user-canon-home.ts'

describe('mapUserCanonPath', () => {
  test('maps the entry and rule paths in both directions', () => {
    expect(mapUserCanonPath({ kind: 'canon', path: 'AGENTS.md' })).toBe('CLAUDE.md')
    expect(mapUserCanonPath({ kind: 'claude', path: 'CLAUDE.md' })).toBe('AGENTS.md')
    expect(mapUserCanonPath({ kind: 'canon', path: '.agents/rules/style.md' })).toBe(
      'rules/style.md',
    )
    expect(mapUserCanonPath({ kind: 'claude', path: 'rules/style.md' })).toBe(
      '.agents/rules/style.md',
    )
    expect(mapUserCanonPath({ kind: 'canon', path: '.agents/contexts/api.md' })).toBeNull()
  })

  test('strips exactly one leading managed-marker line', () => {
    expect(stripUserCanonManagedMarker(`${USER_CANON_MANAGED_MARKER}body`)).toBe('body')
    expect(
      stripUserCanonManagedMarker(`${USER_CANON_MANAGED_MARKER}${USER_CANON_MANAGED_MARKER}body`),
    ).toBe(`${USER_CANON_MANAGED_MARKER}body`)
    expect(stripUserCanonManagedMarker(`before\n${USER_CANON_MANAGED_MARKER}body`)).toBe(
      `before\n${USER_CANON_MANAGED_MARKER}body`,
    )
  })

  test('maps rules only into the Claude home', () => {
    expect(
      USER_CANON_HOME_MAPPINGS.map((mapping) =>
        mapUserCanonHomePath(mapping, '.agents/rules/style.md'),
      ),
    ).toEqual(['rules/style.md', null, null])
  })

  test('an import deletes only absent rows that map to the Claude home', () => {
    expect(
      userCanonHomeImportDeletionSlugs(
        ['AGENTS.md', '.agents/rules/old.md', '.agents/contexts/keep.md'],
        ['AGENTS.md'],
      ),
    ).toEqual(['.agents/rules/old.md'])
  })
})

describe('decideUserCanonHydration', () => {
  test('refuses an unmarked differing file', () => {
    expect(decideUserCanonHydration({ storeBody: 'stored', homeText: 'only copy' })).toEqual({
      action: 'refuse',
    })
  })

  test('overwrites a marked file', () => {
    expect(
      decideUserCanonHydration({
        storeBody: 'stored',
        homeText: `${USER_CANON_MANAGED_MARKER}old`,
      }),
    ).toEqual({ action: 'write', body: `${USER_CANON_MANAGED_MARKER}stored` })
  })

  test('adds the marker when the unmarked file is identical', () => {
    expect(decideUserCanonHydration({ storeBody: 'stored', homeText: 'stored' })).toEqual({
      action: 'write',
      body: `${USER_CANON_MANAGED_MARKER}stored`,
    })
  })

  test('deletes a marked file with no store row', () => {
    expect(
      decideUserCanonHydration({
        storeBody: null,
        homeText: `${USER_CANON_MANAGED_MARKER}old`,
      }),
    ).toEqual({ action: 'delete' })
  })

  test('leaves an unmarked file with no store row alone', () => {
    expect(decideUserCanonHydration({ storeBody: null, homeText: 'only copy' })).toEqual({
      action: 'leave',
    })
  })
})
