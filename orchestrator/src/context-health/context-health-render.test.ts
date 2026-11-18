import { expect, test } from 'bun:test'
import { type ContextHealthFacts, contextHealth } from './context-health.ts'
import { renderContextHealth } from './context-health-render.ts'

test('S1 renders its item count per project and carries it in the JSON report', () => {
  const facts: ContextHealthFacts = {
    now: '2026-11-18T12:00:00.000Z',
    since: '2026-11-11T12:00:00.000Z',
    items: [
      {
        holder: 'task:record-1',
        holderId: 'record-1',
        holderKind: 'task',
        id: 'fact-1',
        recordId: 'item-record-1',
        kind: 'fact',
        body: 'Current context',
        updatedAt: '2026-11-18T12:00:00.000Z',
        project: 'fixture',
        taskKey: 'FIX-1',
        taskStatus: 'active',
        referenceFindings: [],
        unverifiable: null,
        projectRegistered: true,
      },
    ],
    tasks: [],
    cursorStages: [],
    liveRunCursorIds: [],
    reviews: [],
    briefs: [],
    unreachable: null,
  }
  const report = contextHealth(facts)
  expect(report.s1Projects).toEqual([{ project: 'fixture', items: 1 }])
  expect(JSON.parse(JSON.stringify(report)).s1Projects).toEqual([{ project: 'fixture', items: 1 }])
  expect(renderContextHealth(report)).toContain('project=fixture items=1')
})

test('S8 renders only counted stale-reference rules', () => {
  const facts: ContextHealthFacts = {
    now: '2026-11-18T12:00:00.000Z',
    since: '2026-11-11T12:00:00.000Z',
    items: [
      {
        holder: 'session:session-1',
        holderId: 'session-1',
        holderKind: 'session',
        id: 'fact-1',
        recordId: 'item-record-1',
        kind: 'fact',
        body: 'Current context',
        updatedAt: '2026-11-18T12:00:00.000Z',
        project: 'fixture',
        taskKey: null,
        taskStatus: 'active',
        referenceFindings: [{ rule: 'doc/numeral', message: 'spell out the numeral' }],
        unverifiable: null,
        projectRegistered: true,
      },
      {
        holder: 'session:session-2',
        holderId: 'session-2',
        holderKind: 'session',
        id: 'fact-2',
        recordId: 'item-record-2',
        kind: 'fact',
        body: 'Other current context',
        updatedAt: '2026-11-18T12:00:00.000Z',
        project: 'fixture',
        taskKey: null,
        taskStatus: 'active',
        referenceFindings: [{ rule: 'doc/reference-path', message: 'missing path' }],
        unverifiable: null,
        projectRegistered: true,
      },
    ],
    tasks: [],
    cursorStages: [],
    liveRunCursorIds: [],
    reviews: [],
    briefs: [],
    unreachable: null,
  }
  const report = contextHealth(facts)
  const rendered = renderContextHealth(report)

  expect(report.signals.s8).toHaveLength(1)
  expect(report.signals.s8[0]?.staleReferences).toEqual([
    { rule: 'doc/reference-path', message: 'missing path' },
  ])
  expect(rendered).not.toContain('stale=doc/numeral')
  expect(rendered).toContain('stale=doc/reference-path')
})
