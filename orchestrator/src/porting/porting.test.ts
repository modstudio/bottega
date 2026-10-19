import { describe, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
import { projects, upsertProject } from '../project/projects.ts'
import { rememberActiveRecordSpace, rememberProjectSpace } from '../project-space.ts'
import { applyPortCatalogueRow } from '../record/record-cache-port.ts'
import {
  addDoctrineRuleLocal,
  addPairLocal,
  addSkipLocal,
  baselineForPair,
  ledgerRef,
  listDoctrineRules,
  listLedgerRefs,
  listSkips,
  type PortPair,
  pairByProjects,
  resolveLedgerRefLocal,
  retireDoctrineRuleLocal,
  setBaselineLocal,
  setLedgerRefLocal,
} from './porting.ts'

const listPairs = () =>
  db()
    .query(
      'SELECT id,source_project_record_id,target_project_record_id,created_at FROM port_pair ORDER BY id',
    )
    .all() as PortPair[]

describe('porting data model', () => {
  test('stores pair progress and declined candidates with their reasons', () => {
    upsertProject({
      recordId: newRecordId(),
      name: 'source-invented',
      path: '/w/source-invented',
      settings: { keyPrefixes: ['SRC'] },
    })
    upsertProject({
      recordId: newRecordId(),
      name: 'target-invented',
      path: '/w/target-invented',
      settings: { keyPrefixes: ['TGT'] },
    })
    const [source, target] = projects().sort((a, b) => a.name.localeCompare(b.name))
    const pair = addPairLocal(source!.recordId, target!.recordId, '2026-09-01T00:00:00.000Z')
    expect(addPairLocal(source!.recordId, target!.recordId).id).toBe(pair.id)
    expect(listPairs()).toEqual([pair])
    expect(baselineForPair(pair.id)).toEqual({
      pair_id: pair.id,
      source_commit: null,
      scanned_at: null,
    })
    expect(setBaselineLocal(pair.id, 'abc123', '2026-09-02T00:00:00.000Z')).toEqual({
      pair_id: pair.id,
      source_commit: 'abc123',
      scanned_at: '2026-09-02T00:00:00.000Z',
    })
    addSkipLocal(pair.id, 'candidate-one', 'not applicable', '2026-09-03T00:00:00.000Z')
    expect(listSkips(pair.id)).toMatchObject([
      { candidate: 'candidate-one', reason: 'not applicable' },
    ])
    for (const row of db()
      .query<{ record_id: string }, []>(
        'SELECT record_id FROM port_pair UNION ALL SELECT record_id FROM port_baseline UNION ALL SELECT record_id FROM port_skip',
      )
      .all()) {
      expect(row.record_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      )
    }
  })
  test('keeps the same task label distinct in two target projects', () => {
    upsertProject({
      recordId: newRecordId(),
      name: 'source-one-invented',
      path: '/w/source-one',
      settings: {},
    })
    upsertProject({
      recordId: newRecordId(),
      name: 'source-two-invented',
      path: '/w/source-two',
      settings: {},
    })
    upsertProject({
      recordId: newRecordId(),
      name: 'target-invented',
      path: '/w/target',
      settings: { keyPrefixes: ['TGT'] },
    })
    upsertProject({
      recordId: newRecordId(),
      name: 'other-target-invented',
      path: '/w/other-target',
      settings: { keyPrefixes: ['TGT'] },
    })
    const byName = Object.fromEntries(projects().map((project) => [project.name, project]))
    const ref = setLedgerRefLocal({
      taskKey: 'TGT-42',
      targetProjectId: byName['target-invented']!.recordId,
      note: 'adapt this natively',
      createdAt: '2026-09-03T00:00:00.000Z',
      sources: [
        {
          source_project_record_id: byName['source-one-invented']!.recordId,
          commits: ['aaa'],
          paths: ['src/a.ts'],
          note: 'first source',
        },
        {
          source_project_record_id: byName['source-two-invented']!.recordId,
          commits: ['bbb', 'ccc'],
          paths: ['src/b.ts'],
          note: 'second source',
        },
      ],
    })
    expect(ref.target_project_record_id).toBe(byName['target-invented']!.recordId)
    setLedgerRefLocal({
      taskKey: 'TGT-42',
      targetProjectId: byName['other-target-invented']!.recordId,
      note: 'same label, other project',
      sources: [ref.sources[0]!],
    })
    expect(ledgerRef(byName['target-invented']!.recordId, 'TGT-42')!.sources).toEqual([
      {
        source_project_record_id: byName['source-one-invented']!.recordId,
        commits: ['aaa'],
        paths: ['src/a.ts'],
        note: 'first source',
      },
      {
        source_project_record_id: byName['source-two-invented']!.recordId,
        commits: ['bbb', 'ccc'],
        paths: ['src/b.ts'],
        note: 'second source',
      },
    ])
    expect(ledgerRef(byName['other-target-invented']!.recordId, 'TGT-42')).toMatchObject({
      note: 'same label, other project',
      target_project_record_id: byName['other-target-invented']!.recordId,
    })
    expect(listLedgerRefs(true)).toHaveLength(2)
  })
  test('resolution preserves provenance and default listings omit completed refs', () => {
    upsertProject({
      recordId: newRecordId(),
      name: 'source-invented',
      path: '/w/source',
      settings: {},
    })
    upsertProject({
      recordId: newRecordId(),
      name: 'target-invented',
      path: '/w/target',
      settings: { keyPrefixes: ['TGT'] },
    })
    const source = projects().find((project) => project.name === 'source-invented')!
    setLedgerRefLocal({
      taskKey: 'TGT-42',
      targetProjectId: projects().find((project) => project.name === 'target-invented')!.recordId,
      note: 'provenance',
      sources: [
        {
          source_project_record_id: source.recordId,
          commits: ['abc'],
          paths: ['src/a.ts'],
          note: 'source',
        },
      ],
    })
    expect(listLedgerRefs()).toHaveLength(1)
    const target = projects().find((project) => project.name === 'target-invented')!
    expect(
      resolveLedgerRefLocal(target.recordId, 'TGT-42', '2026-09-04T00:00:00.000Z'),
    ).toMatchObject({
      task_key: 'TGT-42',
      resolved_at: '2026-09-04T00:00:00.000Z',
      sources: [{ commits: ['abc'], paths: ['src/a.ts'] }],
    })
    expect(listLedgerRefs()).toEqual([])
    expect(listLedgerRefs(true)).toHaveLength(1)
    expect(resolveLedgerRefLocal(target.recordId, 'TGT-42', 'later')?.resolved_at).toBe(
      '2026-09-04T00:00:00.000Z',
    )
  })
  test('ledger listings omit cached refs for projects not registered locally', () => {
    const space = newRecordId()
    const registeredTargetId = newRecordId()
    upsertProject({
      recordId: registeredTargetId,
      name: 'registered-ledger-target',
      path: '/w/registered-ledger-target',
      settings: {},
    })
    rememberProjectSpace(db(), 'registered-ledger-target', space)
    applyPortCatalogueRow(db(), 'port_ref', {
      id: newRecordId(),
      spaceId: space,
      taskKey: 'REG-1',
      targetProjectId: registeredTargetId,
      note: 'registered target',
      createdAt: '2026-09-03T00:00:00.000Z',
      resolvedAt: null,
      deletedAt: null,
      version: 1,
      updatedAt: '2026-09-03T00:00:00.000Z',
    })
    applyPortCatalogueRow(db(), 'port_ref', {
      id: newRecordId(),
      spaceId: space,
      taskKey: 'UNREGISTERED-1',
      targetProjectId: newRecordId(),
      note: 'unregistered target',
      createdAt: '2026-09-03T00:00:00.000Z',
      resolvedAt: null,
      deletedAt: null,
      version: 1,
      updatedAt: '2026-09-03T00:00:00.000Z',
    })

    expect(listLedgerRefs()).toEqual([
      expect.objectContaining({
        task_key: 'REG-1',
        target_project_record_id: registeredTargetId,
      }),
    ])
  })
  test('retires doctrine without freeing its stable number', () => {
    addDoctrineRuleLocal(
      7,
      'Invented rule',
      'Keep the example invented.',
      '2026-09-01T00:00:00.000Z',
    )
    expect(
      db()
        .query<{ record_id: string }, []>('SELECT record_id FROM port_doctrine WHERE number=7')
        .get()?.record_id,
    ).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    expect(retireDoctrineRuleLocal(7, '2026-09-02T00:00:00.000Z')).toBe(true)
    expect(listDoctrineRules(false)).toEqual([])
    expect(listDoctrineRules()).toMatchObject([
      { number: 7, retired_at: '2026-09-02T00:00:00.000Z' },
    ])
    expect(() => addDoctrineRuleLocal(7, 'Replacement', 'Must not reuse seven.')).toThrow()
  })
  test('a hosted doctrine retirement hides the matching active local rule', () => {
    const space = newRecordId()
    addDoctrineRuleLocal(8, 'Local rule', 'Local body.', '2026-09-01T00:00:00.000Z')
    rememberActiveRecordSpace(db(), space)
    applyPortCatalogueRow(db(), 'port_doctrine', {
      id: newRecordId(),
      spaceId: space,
      number: 8,
      title: 'Hosted rule',
      body: 'Hosted body.',
      createdAt: '2026-09-01T00:00:00.000Z',
      retiredAt: '2026-09-02T00:00:00.000Z',
      version: 2,
      updatedAt: '2026-09-02T00:00:00.000Z',
    })

    expect(listDoctrineRules(false)).toEqual([])
    expect(listDoctrineRules(true)).toMatchObject([
      { number: 8, title: 'Hosted rule', retired_at: '2026-09-02T00:00:00.000Z' },
    ])
  })
  test('a local skip survives when routing selects a hosted pair', () => {
    const sourceId = newRecordId()
    const targetId = newRecordId()
    const space = newRecordId()
    upsertProject({ recordId: sourceId, name: 'skip-source', path: '/w/skip-source', settings: {} })
    upsertProject({ recordId: targetId, name: 'skip-target', path: '/w/skip-target', settings: {} })
    const localPair = addPairLocal(sourceId, targetId)
    addSkipLocal(localPair.id, 'local-candidate', 'keep this skip')
    rememberProjectSpace(db(), 'skip-target', space)
    applyPortCatalogueRow(db(), 'port_pair', {
      id: newRecordId(),
      spaceId: space,
      sourceProjectId: sourceId,
      targetProjectId: targetId,
      createdAt: '2026-09-03T00:00:00.000Z',
    })

    const routedPair = pairByProjects(sourceId, targetId)!
    expect(routedPair.id).not.toBe(localPair.id)
    expect(listSkips(routedPair.id)).toMatchObject([
      { candidate: 'local-candidate', reason: 'keep this skip' },
    ])
  })
})
