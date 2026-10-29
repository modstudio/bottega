import { describe, expect, test } from 'bun:test'
import { decideCursorArguments } from './workflow-cursor-arguments.ts'

describe('workflow cursor arguments', () => {
  test('late cursor arguments merge into empty slots and conflicting values refuse', () => {
    const none = new Set<string>()
    expect(decideCursorArguments({ key: 'DEV-822' }, { branch: 'DEV-822-work' }, none)).toEqual({
      action: 'merge',
      args: { key: 'DEV-822', branch: 'DEV-822-work' },
      rebindings: [],
    })
    expect(
      decideCursorArguments({ key: 'DEV-822', branch: ' ' }, { branch: 'work' }, none),
    ).toEqual({
      action: 'merge',
      args: { key: 'DEV-822', branch: 'work' },
      rebindings: [],
    })
    expect(
      decideCursorArguments(
        { key: 'DEV-822', worktree: '/tmp/old' },
        { worktree: '/tmp/new' },
        new Set(['worktree']),
      ),
    ).toEqual({
      action: 'merge',
      args: { key: 'DEV-822', worktree: '/tmp/new' },
      rebindings: [{ name: 'worktree', oldValue: '/tmp/old', newValue: '/tmp/new' }],
    })
    expect(
      decideCursorArguments(
        { key: 'DEV-822', branch: 'DEV-822-old' },
        { branch: 'DEV-822-new' },
        new Set(['branch']),
        true,
      ),
    ).toEqual({
      action: 'refuse',
      kind: 'compose-branch',
      storedBranch: 'DEV-822-old',
      suppliedBranch: 'DEV-822-new',
    })
    expect(
      decideCursorArguments(
        { key: 'DEV-822', branch: 'DEV-822-work' },
        { branch: ' DEV-822-work ' },
        new Set(['branch']),
        true,
      ),
    ).toEqual({
      action: 'merge',
      args: { key: 'DEV-822', branch: ' DEV-822-work ' },
      rebindings: [{ name: 'branch', oldValue: 'DEV-822-work', newValue: ' DEV-822-work ' }],
    })
    expect(
      decideCursorArguments(
        { key: 'DEV-822', branch: 'DEV-822-work' },
        { branch: 'DEV-999-work' },
        none,
      ),
    ).toEqual({
      action: 'refuse',
      reason:
        'workflow argument "branch" conflicts with the cursor: stored value "DEV-822-work", supplied value "DEV-999-work"',
    })
    expect(decideCursorArguments({ key: 'DEV-822' }, { key: 'DEV-999' }, new Set(['key']))).toEqual(
      {
        action: 'refuse',
        reason:
          'workflow argument "key" conflicts with the cursor: stored value "DEV-822", supplied value "DEV-999"',
      },
    )
    expect(decideCursorArguments({}, { key: 'DEV-822' }, none)).toEqual({
      action: 'merge',
      args: {},
      rebindings: [],
    })
  })
})
