import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { contextCursorWarning } from './context-cursor-warning-decision.ts'

const tasks = [
  { key: 'DEV-1', project: PLATFORM_SLUG, parent_key: null },
  { key: 'DEV-2', project: PLATFORM_SLUG, parent_key: 'DEV-1' },
  { key: 'DEV-3', project: PLATFORM_SLUG, parent_key: 'DEV-2' },
]

test('warns with the compose command when no cursor carries the task', () => {
  expect(contextCursorWarning({ task: tasks[0]!, openCursors: [], tasks })).toBe(
    `warning: no open workflow cursor carries DEV-1 or its children, so this item reaches no session brief; open one with ${PLATFORM_SLUG} workflow compose <workflow> --project ${PLATFORM_SLUG} --arg key=DEV-1`,
  )
})

test.each([
  ['the task', 'DEV-1'],
  ['a child', 'DEV-2'],
  ['a grandchild', 'DEV-3'],
])('returns no warning for a cursor on %s', (_label, taskKey) => {
  expect(
    contextCursorWarning({
      task: tasks[0]!,
      openCursors: [{ project: PLATFORM_SLUG, taskKey }],
      tasks,
    }),
  ).toBeNull()
})

test('does not count a cursor in another project with the same key', () => {
  expect(
    contextCursorWarning({
      task: tasks[0]!,
      openCursors: [{ project: 'other', taskKey: 'DEV-1' }],
      tasks,
    }),
  ).toStartWith('warning:')
})
