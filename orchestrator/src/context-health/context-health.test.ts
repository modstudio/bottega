import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { type ContextHealthFacts, type ContextHealthItem, contextHealth } from './context-health.ts'

const now = '2026-11-18T12:00:00.000Z'
const baseItem = (overrides: Partial<ContextHealthItem> = {}): ContextHealthItem => ({
  holder: 'session:s1',
  holderId: 's1',
  holderKind: 'session',
  id: 'i1',
  recordId: 'r1',
  kind: 'fact',
  body: 'Current context',
  updatedAt: now,
  project: null,
  taskKey: null,
  taskStatus: null,
  referenceFindings: [],
  unverifiable: null,
  projectRegistered: true,
  ...overrides,
})
const facts = (overrides: Partial<ContextHealthFacts> = {}): ContextHealthFacts => ({
  now,
  since: '2026-11-11T12:00:00.000Z',
  items: [],
  tasks: [],
  cursorStages: [],
  liveRunCursorIds: [],
  reviews: [],
  briefs: [],
  unreachable: null,
  ...overrides,
})

describe('context health signals', () => {
  test('S1 counts task context not carried by a cursor and clears when carried', () => {
    const item = baseItem({
      holder: 'task:t1',
      holderId: 't1',
      holderKind: 'task',
      project: PLATFORM_SLUG,
      taskKey: 'DEV-1',
    })
    expect(contextHealth(facts({ items: [item] })).signals.s1).toHaveLength(1)
    expect(
      contextHealth(
        facts({
          items: [item],
          cursorStages: [
            { recordId: 'c1', project: PLATFORM_SLUG, taskKey: 'DEV-1', state: 'running' },
          ],
        }),
      ).signals.s1,
    ).toHaveLength(0)
    expect(contextHealth(facts({ items: [item] })).s1Projects).toEqual([
      { project: PLATFORM_SLUG, items: 1 },
    ])
  })

  test('S1 treats a closed stage as reached only while a live run is bound to it', () => {
    const item = baseItem({
      holder: 'task:t1',
      holderId: 't1',
      holderKind: 'task',
      project: PLATFORM_SLUG,
      taskKey: 'DEV-1',
    })
    const cursorStages = [
      { recordId: 'c1', project: PLATFORM_SLUG, taskKey: 'DEV-1', state: 'done' },
    ]
    expect(
      contextHealth(facts({ items: [item], cursorStages, liveRunCursorIds: ['c1'] })).signals.s1,
    ).toHaveLength(0)
    expect(contextHealth(facts({ items: [item], cursorStages })).signals.s1).toHaveLength(1)
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

  test('S8 ignores line-anchor findings but reports stale-reference rules', () => {
    expect(
      contextHealth(
        facts({
          items: [
            baseItem({
              referenceFindings: [{ rule: 'doc/line-anchor', message: 'unstable line' }],
            }),
          ],
        }),
      ).signals.s8,
    ).toHaveLength(0)
    expect(
      contextHealth(
        facts({
          items: [
            baseItem({
              referenceFindings: [{ rule: 'doc/reference-path', message: 'missing path' }],
            }),
          ],
        }),
      ).signals.s8,
    ).toHaveLength(1)
  })

  test('S8 reports an unverifiable project instead of clean', () => {
    expect(
      contextHealth(facts({ items: [baseItem({ unverifiable: 'checkout missing' })] })).signals.s8,
    ).toHaveLength(1)
    expect(contextHealth(facts({ items: [baseItem()] })).signals.s8).toHaveLength(0)
  })

  test('S8 reports a named project absent from the register as unverifiable', () => {
    const [finding] = contextHealth(
      facts({ items: [baseItem({ project: 'retired-project', projectRegistered: false })] }),
    ).signals.s8
    expect(finding?.unverifiable).toBe(
      'item names project retired-project, which is not a registered project',
    )
  })

  test('an unresolved task holder names the orphan and never offers a cursor selector', () => {
    const [finding] = contextHealth(
      facts({
        items: [
          baseItem({
            holder: 'task:task-record',
            holderId: 'task-record',
            holderKind: 'task',
            taskStatus: 'done',
          }),
        ],
      }),
    ).signals.s2
    expect(finding?.remedy).toBe(
      'context item i1 is held by task holder task-record whose task no longer resolves; no verb clears it yet (note 01a1f05d)',
    )
    expect(finding?.remedy).not.toContain('--cursor')
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
