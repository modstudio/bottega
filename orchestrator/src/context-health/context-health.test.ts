import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { type ContextHealthFacts, type ContextHealthItem, contextHealth } from './context-health.ts'

const now = '2026-11-18T12:00:00.000Z'
const baseItem = (overrides: Partial<ContextHealthItem> = {}): ContextHealthItem => ({
  holder: 'session:s1',
  holderKind: 'session',
  id: 'i1',
  recordId: 'r1',
  kind: 'fact',
  body: 'Current context',
  updatedAt: now,
  project: null,
  taskKey: null,
  taskStatus: null,
  staleReferences: [],
  unverifiable: null,
  ...overrides,
})
const facts = (overrides: Partial<ContextHealthFacts> = {}): ContextHealthFacts => ({
  now,
  since: '2026-11-11T12:00:00.000Z',
  items: [],
  tasks: [],
  openCursors: [],
  reviews: [],
  briefs: [],
  unreachable: null,
  ...overrides,
})

describe('context health signals', () => {
  test('S1 counts task context not carried by a cursor and clears when carried', () => {
    const item = baseItem({
      holder: 'task:t1',
      holderKind: 'task',
      project: PLATFORM_SLUG,
      taskKey: 'DEV-1',
    })
    expect(contextHealth(facts({ items: [item] })).signals.s1).toHaveLength(1)
    expect(
      contextHealth(
        facts({ items: [item], openCursors: [{ project: PLATFORM_SLUG, taskKey: 'DEV-1' }] }),
      ).signals.s1,
    ).toHaveLength(0)
  })

  test('S2 counts only done-task residue', () => {
    expect(
      contextHealth(facts({ items: [baseItem({ taskStatus: 'done' })] })).signals.s2,
    ).toHaveLength(1)
    expect(
      contextHealth(facts({ items: [baseItem({ taskStatus: 'active' })] })).signals.s2,
    ).toHaveLength(0)
  })

  test('S3 applies the declared kind cap', () => {
    expect(
      contextHealth(facts({ items: [baseItem({ kind: 'pointer', body: 'x'.repeat(401) })] }))
        .signals.s3,
    ).toHaveLength(1)
    expect(
      contextHealth(facts({ items: [baseItem({ kind: 'pointer', body: 'x'.repeat(400) })] }))
        .signals.s3,
    ).toHaveLength(0)
  })

  test('S4 counts whitespace-normalised duplicates across holders', () => {
    const first = baseItem({ body: 'Same\n fact' })
    const second = baseItem({ holder: 'session:s2', recordId: 'r2', body: 'same fact' })
    expect(contextHealth(facts({ items: [first, second] })).signals.s4).toHaveLength(2)
    expect(contextHealth(facts({ items: [first] })).signals.s4).toHaveLength(0)
  })

  test('S5 counts old live facts but excludes positions', () => {
    const updatedAt = '2026-11-10T11:59:59.999Z'
    expect(contextHealth(facts({ items: [baseItem({ updatedAt })] })).signals.s5).toHaveLength(1)
    expect(
      contextHealth(facts({ items: [baseItem({ updatedAt, kind: 'position' })] })).signals.s5,
    ).toHaveLength(0)
  })

  test('S6 counts sessions whose nonempty reviews are all unflagged', () => {
    expect(
      contextHealth(facts({ reviews: [{ sessionId: 's1', at: now, items: 1, flagged: 0 }] }))
        .signals.s6,
    ).toHaveLength(1)
    expect(
      contextHealth(facts({ reviews: [{ sessionId: 's1', at: now, items: 1, flagged: 1 }] }))
        .signals.s6,
    ).toHaveLength(0)
  })

  test('S7 reports compact brief cursor and cap shares', () => {
    const report = contextHealth(
      facts({
        briefs: [{ sessionId: 's1', at: now, source: 'compact', cursors: 0, overCap: true }],
      }),
    )
    expect(report.signals.s7).toEqual([
      {
        sessionId: 's1',
        compactBriefs: 1,
        zeroCursorBriefs: 1,
        zeroCursorShare: 1,
        overCapBriefs: 1,
        overCapShare: 1,
      },
    ])
    expect(contextHealth(facts()).signals.s7).toHaveLength(0)
  })

  test('S8 ignores file line anchors excluded by the adapter', () => {
    expect(
      contextHealth(facts({ items: [baseItem({ body: '`file.ts:12`' })] })).signals.s8,
    ).toHaveLength(0)
  })

  test('S8 reports an unverifiable project instead of clean', () => {
    expect(
      contextHealth(facts({ items: [baseItem({ unverifiable: 'checkout missing' })] })).signals.s8,
    ).toHaveLength(1)
    expect(contextHealth(facts({ items: [baseItem()] })).signals.s8).toHaveLength(0)
  })

  test('unreachable data has the error verdict and no false zero verdict', () => {
    const report = contextHealth(
      facts({
        unreachable: {
          resource: 'context store',
          detail: 'missing table',
          remedy: `run ${PLATFORM_SLUG} machine update`,
        },
      }),
    )
    expect(report).toMatchObject({
      verdict: 'unreachable',
      exitCode: 1,
      unreachable: { resource: 'context store' },
    })
  })
})
