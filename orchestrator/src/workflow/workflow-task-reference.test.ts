import { expect, test } from 'bun:test'
import { taskReadRefusal } from './workflow-task-reference.ts'

test('task-list refusals withhold secret-shaped child-process detail', () => {
  const refusal = taskReadRefusal('beta', 'DEV-42', 'tracker failed: token=super-secret')

  expect(refusal.message).toContain('detail withheld')
  expect(refusal.message).not.toContain('super-secret')
  expect(refusal.message).toContain('task list --project beta --json')
})
