import { describe, expect, test } from 'bun:test'
import { decideTaskClose } from './task-close-decision.ts'

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
