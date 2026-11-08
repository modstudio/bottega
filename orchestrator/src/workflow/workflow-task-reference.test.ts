import { expect, test } from 'bun:test'
import { resolveHubTaskReference, taskReadRefusal } from './workflow-task-reference.ts'

test('resolves a shared key only within the workflow project', async () => {
  const reader = async (project: string) => [
    { key: 'SHARED-42', record_id: `task-${project}`, project },
  ]

  await expect(resolveHubTaskReference('alpha', 'SHARED-42', reader)).resolves.toMatchObject({
    record_id: 'task-alpha',
  })
  await expect(resolveHubTaskReference('beta', 'SHARED-42', reader)).resolves.toMatchObject({
    record_id: 'task-beta',
  })
  await expect(resolveHubTaskReference(null, 'SHARED-42', reader)).resolves.toBeNull()
})

test('task-list refusals withhold secret-shaped child-process detail', () => {
  const refusal = taskReadRefusal('beta', 'tracker failed: token=super-secret')

  expect(refusal.message).toContain('tracker failed: [withheld: assignment]')
  expect(refusal.message).not.toContain('super-secret')
  expect(refusal.message).toContain('task list --project beta --json')
})
