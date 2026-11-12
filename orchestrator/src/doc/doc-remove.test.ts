import { describe, expect, test } from 'bun:test'
import { removeContextItemForLifecycle, removeTaskContextHolder } from './doc-remove.ts'

describe('document removal', () => {
  test('lifecycle context removal refuses a non-session subject', async () => {
    await expect(
      removeContextItemForLifecycle('task:DEV-1844', 'next', {
        reason: 'invalid lifecycle removal',
      }),
    ).rejects.toThrow('lifecycle context removal requires a session: subject')
  })

  test('task holder clear refuses a non-task subject', async () => {
    await expect(
      removeTaskContextHolder('session:fixture', [], { reason: 'invalid task clear' }),
    ).rejects.toThrow('task context clear requires a task: subject')
  })
})
