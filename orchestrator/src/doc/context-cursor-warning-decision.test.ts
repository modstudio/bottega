import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  contextCursorWarning,
  cursorAncestorTasks,
  taskHoldersCarriedByOpenCursors,
  tasksCarriedByOpenCursors,
} from './context-cursor-warning-decision.ts'

const tasks = [
  { key: 'DEV-1', project: PLATFORM_SLUG, parent_key: null },
  { key: 'DEV-2', project: PLATFORM_SLUG, parent_key: 'DEV-1' },
  { key: 'DEV-3', project: PLATFORM_SLUG, parent_key: 'DEV-2' },
]

test('warns with the compose command when no cursor carries the task', () => {
  expect(contextCursorWarning({ task: tasks[0]!, openCursors: [], tasks })).toBe(
    `warning: no open workflow cursor carries DEV-1 or its descendants, so this item reaches no session brief; open one with ${PLATFORM_SLUG} workflow compose <workflow> --project '${PLATFORM_SLUG}' --arg 'key=DEV-1'`,
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

test('a cursor on a grandchild carries the target through resolved ancestor reads', async () => {
  const target = tasks[0]!
  const ancestors = await cursorAncestorTasks({
    task: target,
    openCursors: [{ project: PLATFORM_SLUG, taskKey: 'DEV-3' }],
    lookup: async (project, key) =>
      tasks.find((task) => task.project === project && task.key === key) ?? null,
  })

  expect(
    contextCursorWarning({
      task: target,
      openCursors: [{ project: PLATFORM_SLUG, taskKey: 'DEV-3' }],
      tasks: ancestors,
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

test('carried task pairs include direct and ancestor tasks without crossing projects', () => {
  const carried = tasksCarriedByOpenCursors(
    [
      { project: PLATFORM_SLUG, taskKey: 'DEV-3' },
      { project: 'other', taskKey: 'DEV-1' },
      { project: PLATFORM_SLUG, taskKey: 'DEV-missing' },
    ],
    tasks,
  )

  expect(carried).toContainEqual({ project: PLATFORM_SLUG, key: 'DEV-3' })
  expect(carried).toContainEqual({ project: PLATFORM_SLUG, key: 'DEV-2' })
  expect(carried).toContainEqual({ project: PLATFORM_SLUG, key: 'DEV-1' })
  expect(carried).toContainEqual({ project: 'other', key: 'DEV-1' })
  expect(carried).toContainEqual({ project: PLATFORM_SLUG, key: 'DEV-missing' })
  expect(carried).not.toContainEqual({ project: 'other', key: 'DEV-2' })
})

test('carried task holders map only task pairs present in the task list', () => {
  const holders = taskHoldersCarriedByOpenCursors(
    [
      { project: PLATFORM_SLUG, taskKey: 'DEV-3' },
      { project: PLATFORM_SLUG, taskKey: 'DEV-missing' },
    ],
    tasks.map((task, index) => ({ ...task, record_id: `record-${index + 1}` })),
  )

  expect(holders).toContain('task:record-1')
  expect(holders).toContain('task:record-2')
  expect(holders).toContain('task:record-3')
  expect(holders).toHaveLength(3)
})
