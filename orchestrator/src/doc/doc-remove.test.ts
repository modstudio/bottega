import { describe, expect, test } from 'bun:test'
import { removeContextItemForLifecycle } from './doc-remove.ts'

describe('document removal', () => {
  test('lifecycle context removal refuses a non-session subject', async () => {
    await expect(
      removeContextItemForLifecycle('task:DEV-1844', 'next', {
        reason: 'invalid lifecycle removal',
      }),
    ).rejects.toThrow('lifecycle context removal requires a session: subject')
  })
})
