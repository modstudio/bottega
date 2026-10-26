import { expect, test } from 'bun:test'
import { parseHubTaskResponse, taskReadRefusal } from './workflow-task-reference.ts'

test('parses the task reference from a task-show response', () => {
  expect(
    parseHubTaskResponse({
      task: {
        key: 'SHARED-42',
        record_id: '01990000-0000-7000-8000-000000000895',
        project: 'beta',
        title: 'Shared task',
      },
      comments: [],
      documents: [],
    }),
  ).toMatchObject({
    key: 'SHARED-42',
    record_id: '01990000-0000-7000-8000-000000000895',
    project: 'beta',
  })
})

test('task-list refusals withhold secret-shaped child-process detail', () => {
  const refusal = taskReadRefusal('beta', 'DEV-42', 'tracker failed: token=super-secret')

  expect(refusal.message).toContain('detail withheld')
  expect(refusal.message).not.toContain('super-secret')
  expect(refusal.message).toContain('task list --project beta --json')
})
