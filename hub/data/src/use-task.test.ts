import { expect, test } from 'bun:test'
import { isTaskBodyConflict, reloadTaskBody, taskBodySaveInput } from './use-task.ts'

test('task body conflict reload clears conflict and the next save uses the refreshed version', async () => {
  const conflict = { data: { code: 'CONFLICT' } }
  expect(isTaskBodyConflict(conflict)).toBe(true)

  let currentVersion = 'old-version'
  let cleared = false
  const calls: string[] = []
  await reloadTaskBody(
    async () => {
      calls.push('fetch')
      currentVersion = 'new-version'
    },
    async () => {
      calls.push('invalidate')
    },
    () => {
      calls.push('clear')
      cleared = true
    },
  )

  expect(calls).toEqual(['fetch', 'invalidate', 'clear'])
  expect(cleared).toBe(true)
  expect(taskBodySaveInput({ key: 'DEV-1', scope: {} }, 'next body', currentVersion)).toEqual({
    key: 'DEV-1',
    scope: {},
    body: 'next body',
    expectedVersion: 'new-version',
  })
})
