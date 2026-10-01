import { describe, expect, test } from 'bun:test'
import { selectPromotionTask } from './hosted-notes.ts'
import type { HostedTask } from './hosted-tasks.ts'

describe('hosted note promotion task ownership', () => {
  test('passes a tracker key through without calling the minting path', async () => {
    let minted = false
    const selected = await selectPromotionTask(
      'ADN-42',
      async () => null,
      async () => {
        minted = true
        return { key: 'ADN-43' } as HostedTask
      },
    )

    expect(selected).toEqual({ key: 'ADN-42', task: null })
    expect(minted).toBeFalse()
  })
})
