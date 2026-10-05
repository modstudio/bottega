import { describe, expect, test } from 'bun:test'
import { closeThenPrune } from './task-close.ts'
import { decideTaskClose } from './task-close-decision.ts'
import type { TaskRow } from './task.ts'

const closedTask = { project: 'bottega', key: 'DEV-1' } as TaskRow

describe('task close decision', () => {
  test('closes when every branch is landed', () => {
    expect(decideTaskClose({ available: true, unlanded: [] })).toEqual({
      action: 'close',
      comment: null,
    })
  })

  test('refuses and names unlanded work', () => {
    expect(
      decideTaskClose({
        available: true,
        unlanded: [{ branch: 'DEV-1027-worker', reason: 'unlanded; 2 commits not on trunk' }],
      }),
    ).toEqual({
      action: 'refuse',
      reason:
        'refusing to close a task with unlanded branch work:\n' +
        '  DEV-1027-worker: unlanded; 2 commits not on trunk\n' +
        'Land each branch, delete it, or pass --abandon "<reason>" to close and record why the work was abandoned.',
    })
  })

  test('force closes unlanded work and records its reason', () => {
    expect(
      decideTaskClose(
        {
          available: true,
          unlanded: [{ branch: 'DEV-1027-worker', reason: 'unlanded' }],
        },
        'prototype deliberately abandoned',
      ),
    ).toEqual({ action: 'close', comment: 'prototype deliberately abandoned' })
  })

  test('refuses when classification is unavailable', () => {
    expect(decideTaskClose({ available: false, reason: 'git failed' })).toEqual({
      action: 'refuse',
      reason:
        'branch classification unavailable: git failed; restore orch and git access, then retry',
    })
  })
})

describe('task close claim release', () => {
  test('releases claims after close even when branches are kept', async () => {
    let released = ''
    const result = await closeThenPrune('DEV-1', {}, true, undefined, {
      close: async () => closedTask,
      releaseClaims: async (project, key) => {
        released = `${project}:${key}`
        return { released: 2 }
      },
    })
    expect(released).toBe('bottega:DEV-1')
    expect(result.claimReleaseError).toBeNull()
  })

  test('surfaces a claim release error', async () => {
    const result = await closeThenPrune('DEV-1', {}, true, undefined, {
      close: async () => closedTask,
      releaseClaims: async () => {
        throw new Error('orch unavailable')
      },
    })
    expect(result.claimReleaseError?.message).toBe('orch unavailable')
  })

  test('returns the closed task when claim release fails', async () => {
    const result = await closeThenPrune('DEV-1', {}, true, undefined, {
      close: async () => closedTask,
      releaseClaims: async () => {
        throw new Error('release failed')
      },
    })
    expect(result.closed).toBe(closedTask)
  })
})
