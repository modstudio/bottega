import { expect, test } from 'bun:test'
import { contextHealth, type ContextHealthFacts } from './context-health.ts'
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
  expect(JSON.parse(JSON.stringify(report)).s1Projects).toEqual([
    { project: 'fixture', items: 1 },
  ])
  expect(renderContextHealth(report)).toContain('project=fixture items=1')
})
