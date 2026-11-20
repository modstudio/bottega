import { expect, test } from 'bun:test'
import { taskSingleReadViolations } from './check-task-single-read.ts'

test('refuses the former context task lookup through a project list', () => {
  const source = `
    async function resolveContextTask(project, key) {
      const tasks = await readHubTasks(project)
      return tasks.find((task) => task.key === key)
    }
  `
  expect(taskSingleReadViolations(source, 'orchestrator/src/doc/context-write-adapter.ts')).toEqual(
    [{ file: 'orchestrator/src/doc/context-write-adapter.ts', line: 2 }],
  )
})

test('allows set reads and single-task show reads', () => {
  expect(
    taskSingleReadViolations(
      `async function children() { return taskReader().list({ parent }) }`,
      'orchestrator/src/example.ts',
    ),
  ).toEqual([])
  expect(
    taskSingleReadViolations(
      `async function one() { return taskReader().show(key, { project }) }`,
      'orchestrator/src/example.ts',
    ),
  ).toEqual([])
})
