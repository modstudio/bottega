import { describe, expect, test } from 'bun:test'
import { selectPromotionTask, validateHostedPromotionTaskKey } from './hosted-notes.ts'
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

  test('validates supplied task keys against the hosted project', () => {
    const remote = {
      key_prefixes: ['ADN', 'LEGACY'],
      tracker: { protocol: 'array-mcp' },
    }
    expect(() => validateHostedPromotionTaskKey('ADN-42', 'adanim', remote)).not.toThrow()
    expect(() => validateHostedPromotionTaskKey('LEGACY-7', 'adanim', remote)).not.toThrow()
    expect(() => validateHostedPromotionTaskKey('DEV-42', 'adanim', remote)).toThrow(
      "task key 'DEV-42' has the wrong prefix for project adanim; expected: ADN, LEGACY",
    )
    expect(() => validateHostedPromotionTaskKey('', 'adanim', remote)).toThrow(
      "task key '' has the wrong prefix for project adanim",
    )
    expect(() =>
      validateHostedPromotionTaskKey('DEV-42', 'hub-owned', {
        key_prefixes: ['DEV'],
        tracker: { protocol: 'hub' },
      }),
    ).toThrow("project 'hub-owned' does not have a remote tracker")
    expect(() => validateHostedPromotionTaskKey('ADN-42', 'missing', undefined)).toThrow(
      "project 'missing' does not have a remote tracker",
    )
  })
})
