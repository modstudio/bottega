import { expect, test } from 'bun:test'
import { auditUnmeasuredDefectCursors, type ClassAuditCursor } from './workflow-class-audit.ts'

const cursor = (overrides: Partial<ClassAuditCursor>): ClassAuditCursor => ({
  number: 1,
  recordId: 'cursor-1',
  project: 'fixture',
  workflow: 'fix-defect',
  key: 'DEV-1',
  taskRecordId: 'task-1',
  createdAt: '2026-11-20T00:00:00Z',
  closed: [{ slug: 'implement-fix' }],
  ...overrides,
})

test('counts a promoted fix-defect cursor that reached implement without measurement', () => {
  expect(
    auditUnmeasuredDefectCursors({
      since: '2026-11-18T00:00:00Z',
      cursors: [cursor({})],
      promoted: [{ project: 'fixture', key: 'DEV-1' }],
      implementRuns: [],
    }).count,
  ).toBe(1)
})

test('skips a cursor carrying class-measured evidence', () => {
  expect(
    auditUnmeasuredDefectCursors({
      since: '2026-11-18T00:00:00Z',
      cursors: [
        cursor({
          closed: [
            {
              slug: 'measure-class',
              evidence: ['--class', '--command', '--exec', '--count'].map((flag) => ({
                flag,
                value: 'value',
              })),
            },
            { slug: 'implement-fix' },
          ],
        }),
      ],
      promoted: [{ project: 'fixture', key: 'DEV-1' }],
      implementRuns: [],
    }).count,
  ).toBe(0)
})

test('counts a promoted plan-task cursor followed by an implement run on its task', () => {
  expect(
    auditUnmeasuredDefectCursors({
      since: '2026-11-18T00:00:00Z',
      cursors: [cursor({ workflow: 'plan-task', closed: [] })],
      promoted: [{ project: 'fixture', key: 'DEV-1' }],
      implementRuns: [
        { cursorRecordId: null, taskRecordId: 'task-1', startedAt: '2026-11-21T00:00:00Z' },
      ],
    }).count,
  ).toBe(1)
})
