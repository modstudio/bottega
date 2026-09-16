import { describe, expect, test } from 'bun:test'
import {
  HOOK_TREE_JOB,
  HOOK_TREE_NOTICE_AFTER_MS,
  hookTreeEvidenceDecision,
  hookTreeHoldDecision,
  hookTreeNotice,
  nonHookTreeStatsSql,
  shouldSweepHookTree,
} from './hook-tree.ts'

describe('hook-tree lifecycle decisions', () => {
  test('holds hook trees without an expiry and leaves ordinary holds unchanged', () => {
    const ordinary = { held: false as const, expiredAt: '2026-09-16T00:00:00.000Z' }
    expect(hookTreeHoldDecision({ job: HOOK_TREE_JOB }, ordinary)).toEqual({
      held: true,
      until: null,
      reason: 'hook tree; remove with orch tree remove <path>',
    })
    expect(hookTreeHoldDecision({ job: 'implement' }, ordinary)).toBe(ordinary)
  })

  test('keeps hook trees out of sweep without changing ordinary runs', () => {
    expect(shouldSweepHookTree({ job: HOOK_TREE_JOB })).toBe(false)
    expect(shouldSweepHookTree({ job: 'implement' })).toBe(true)
  })

  test('notices only old hook trees', () => {
    const clock = Date.parse('2026-09-16T12:00:00.000Z')
    const old = new Date(clock - HOOK_TREE_NOTICE_AFTER_MS - 1).toISOString()
    const boundary = new Date(clock - HOOK_TREE_NOTICE_AFTER_MS).toISOString()
    const hook = {
      id: 41,
      job: HOOK_TREE_JOB,
      status: 'ok',
      path: '/trees/orch-41',
      startedAt: old,
    }
    expect(hookTreeNotice(hook, clock)).toMatchObject({
      kind: 'hook-tree-old',
      detail: 'hook tree /trees/orch-41 remains provisioned',
      action: 'orch tree remove /trees/orch-41',
    })
    expect(hookTreeNotice({ ...hook, startedAt: boundary }, clock)).toBeNull()
    expect(hookTreeNotice({ ...hook, job: 'implement' }, clock)).toBeNull()
  })

  test('notices a non-ok hook tree immediately', () => {
    const clock = Date.parse('2026-09-16T12:00:00.000Z')
    const hook = {
      id: 42,
      job: HOOK_TREE_JOB,
      status: 'stale',
      path: '/trees/orch-42',
      startedAt: new Date(clock).toISOString(),
    }
    expect(hookTreeNotice(hook, clock)).toMatchObject({
      kind: 'hook-tree-failed',
      detail: 'hook tree /trees/orch-42 has run status stale',
      action: 'orch tree remove /trees/orch-42',
    })
  })

  test('excludes lifecycle rows from evidence, reminders, and stats', () => {
    expect(hookTreeEvidenceDecision()).toEqual({
      evidenceExcluded: 'hook tree lifecycle row; not agent execution',
    })
    expect(nonHookTreeStatsSql('r')).toBe("r.job <> 'hook-tree'")
  })
})
