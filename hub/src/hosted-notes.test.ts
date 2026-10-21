import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
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

  test('requires an existing hub task when linking a hosted hub-owned note', async () => {
    await expect(
      selectPromotionTask(
        'DEV-42',
        async () => null,
        async () => ({}) as HostedTask,
        true,
        'hub',
      ),
    ).rejects.toThrow(`${PLATFORM_SLUG} task list --project hub`)
    await expect(
      selectPromotionTask(
        'DEV-42',
        async () => ({ id: 'task-id', key: 'DEV-42', source: 'git' }) as HostedTask,
        async () => ({}) as HostedTask,
        true,
        'hub',
      ),
    ).rejects.toThrow(`${PLATFORM_SLUG} task list --project hub`)
    const task = { id: 'task-id', key: 'DEV-42', source: 'local' } as HostedTask
    await expect(
      selectPromotionTask(
        'DEV-42',
        async () => task,
        async () => ({}) as HostedTask,
        true,
        'hub',
      ),
    ).resolves.toEqual({ key: 'DEV-42', task })
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
    ).not.toThrow()
    expect(() => validateHostedPromotionTaskKey('ADN-42', 'missing', undefined)).toThrow(
      `${PLATFORM_SLUG} task list --project missing`,
    )
  })
})
