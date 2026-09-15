import { describe, expect, test } from 'bun:test'
import { upsertProject, projects } from './projects.ts'
import {
  addDoctrineRule,
  addPair,
  addSkip,
  baselineForPair,
  ledgerRef,
  listDoctrineRules,
  listLedgerRefs,
  listPairs,
  listSkips,
  resolveLedgerRef,
  retireDoctrineRule,
  setBaseline,
  setLedgerRef,
} from './porting.ts'
describe('porting data model', () => {
  test('stores pair progress and declined candidates with their reasons', () => {
    upsertProject({
      name: 'source-invented',
      path: '/w/source-invented',
      settings: { keyPrefixes: ['SRC'] },
    })
    upsertProject({
      name: 'target-invented',
      path: '/w/target-invented',
      settings: { keyPrefixes: ['TGT'] },
    })
    const [source, target] = projects().sort((a, b) => a.name.localeCompare(b.name))
    const pair = addPair(source!.id, target!.id, '2026-09-01T00:00:00.000Z')
    expect(addPair(source!.id, target!.id).id).toBe(pair.id)
    expect(listPairs()).toEqual([pair])
    expect(baselineForPair(pair.id)).toEqual({
      pair_id: pair.id,
      source_commit: null,
      scanned_at: null,
    })
    expect(setBaseline(pair.id, 'abc123', '2026-09-02T00:00:00.000Z')).toEqual({
      pair_id: pair.id,
      source_commit: 'abc123',
      scanned_at: '2026-09-02T00:00:00.000Z',
    })
    addSkip(pair.id, 'candidate-one', 'not applicable', '2026-09-03T00:00:00.000Z')
    expect(listSkips(pair.id)).toMatchObject([
      { candidate: 'candidate-one', reason: 'not applicable' },
    ])
  })
  test('keeps each ledger source project distinct and resolves the target by key prefix', () => {
    upsertProject({ name: 'source-one-invented', path: '/w/source-one', settings: {} })
    upsertProject({ name: 'source-two-invented', path: '/w/source-two', settings: {} })
    upsertProject({
      name: 'target-invented',
      path: '/w/target',
      settings: { keyPrefixes: ['TGT'] },
    })
    const byName = Object.fromEntries(projects().map((project) => [project.name, project]))
    const ref = setLedgerRef({
      taskKey: 'TGT-42',
      note: 'adapt this natively',
      createdAt: '2026-09-03T00:00:00.000Z',
      sources: [
        {
          source_project_id: byName['source-one-invented']!.id,
          commits: ['aaa'],
          paths: ['src/a.ts'],
          note: 'first source',
        },
        {
          source_project_id: byName['source-two-invented']!.id,
          commits: ['bbb', 'ccc'],
          paths: ['src/b.ts'],
          note: 'second source',
        },
      ],
    })
    expect(ref.target_project_id).toBe(byName['target-invented']!.id)
    expect(ledgerRef('TGT-42')!.sources).toEqual([
      {
        source_project_id: byName['source-one-invented']!.id,
        commits: ['aaa'],
        paths: ['src/a.ts'],
        note: 'first source',
      },
      {
        source_project_id: byName['source-two-invented']!.id,
        commits: ['bbb', 'ccc'],
        paths: ['src/b.ts'],
        note: 'second source',
      },
    ])
    expect(() => setLedgerRef({ taskKey: 'NONE-1', note: '', sources: ref.sources })).toThrow(
      'no registered project owns task key',
    )
  })
  test('resolution preserves provenance and default listings omit completed refs', () => {
    upsertProject({ name: 'source-invented', path: '/w/source', settings: {} })
    upsertProject({
      name: 'target-invented',
      path: '/w/target',
      settings: { keyPrefixes: ['TGT'] },
    })
    const source = projects().find((project) => project.name === 'source-invented')!
    setLedgerRef({
      taskKey: 'TGT-42',
      note: 'provenance',
      sources: [
        { source_project_id: source.id, commits: ['abc'], paths: ['src/a.ts'], note: 'source' },
      ],
    })
    expect(listLedgerRefs()).toHaveLength(1)
    expect(resolveLedgerRef('TGT-42', '2026-09-04T00:00:00.000Z')).toMatchObject({
      task_key: 'TGT-42',
      resolved_at: '2026-09-04T00:00:00.000Z',
      sources: [{ commits: ['abc'], paths: ['src/a.ts'] }],
    })
    expect(listLedgerRefs()).toEqual([])
    expect(listLedgerRefs(true)).toHaveLength(1)
    expect(resolveLedgerRef('TGT-42', 'later')?.resolved_at).toBe('2026-09-04T00:00:00.000Z')
  })
  test('retires doctrine without freeing its stable number', () => {
    addDoctrineRule(7, 'Invented rule', 'Keep the example invented.', '2026-09-01T00:00:00.000Z')
    expect(retireDoctrineRule(7, '2026-09-02T00:00:00.000Z')).toBe(true)
    expect(listDoctrineRules(false)).toEqual([])
    expect(listDoctrineRules()).toMatchObject([
      { number: 7, retired_at: '2026-09-02T00:00:00.000Z' },
    ])
    expect(() => addDoctrineRule(7, 'Replacement', 'Must not reuse seven.')).toThrow()
  })
})
