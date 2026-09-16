import { describe, expect, test } from 'bun:test'
import { catchFixTreeDisposition } from './issue-catch.ts'

describe('failed fix tree disposition', () => {
  test('holds only a dirty fix tree and says why', () => {
    const dirty = catchFixTreeDisposition({ path: '/tmp/tree', branch: 'DEV-1-fix' }, true)
    expect(dirty.action).toBe('hold')
    expect(dirty.handoff).toContain('Worktree held at /tmp/tree')
    expect(dirty.handoff).toContain('uncommitted work; not reconstructible from the branch')
  })

  test('releases a clean fix tree and names the retained branch', () => {
    const clean = catchFixTreeDisposition({ path: '/tmp/tree', branch: 'DEV-1-fix' }, false)
    expect(clean.action).toBe('release')
    expect(clean.handoff).toBe('Worktree released; committed work remains on branch DEV-1-fix.')
  })

  test('does nothing when no fix tree exists', () => {
    expect(catchFixTreeDisposition(null, true)).toEqual({
      action: 'none',
      handoff: 'Fix worktree: none recorded.',
    })
  })
})
