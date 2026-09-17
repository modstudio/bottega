import { describe, expect, test } from 'bun:test'
import {
  classifyWorktreeDirty,
  type TreeOwnershipInput,
  treeOwnership,
} from './worktree-attribution.ts'

const base: TreeOwnershipInput = {
  conversationRunIds: [40, 41],
  directoryName: 'technical/DEV-560-orch-40',
  repoRoot: '/projects/alpha',
  branchTemplate: 'technical/{key}-orch-{id}',
  checkout: true,
  marker: { state: 'absent' },
}

describe('treeOwnership', () => {
  test('owns a marker naming any turn in the conversation', () => {
    expect(
      treeOwnership({
        ...base,
        marker: { state: 'present', runId: 41, repoRoot: '/projects/alpha' },
      }),
    ).toBe('owned')
  })

  test('attaches a marker naming another run', () => {
    expect(
      treeOwnership({
        ...base,
        marker: { state: 'present', runId: 42, repoRoot: '/projects/alpha' },
      }),
    ).toBe('attached')
  })

  test('attaches a marker naming the conversation under another repository', () => {
    expect(
      treeOwnership({
        ...base,
        marker: { state: 'present', runId: 40, repoRoot: '/projects/starship' },
      }),
    ).toBe('attached')
  })

  test('owns a legacy orch directory naming a turn in the conversation', () => {
    expect(treeOwnership({ ...base, directoryName: 'orch-41' })).toBe('owned')
  })

  test('attaches a task-branch directory without a marker', () => {
    expect(treeOwnership({ ...base, directoryName: 'STAR-5502' })).toBe('attached')
  })

  test('keeps a checkout whose marker cannot be read', () => {
    expect(treeOwnership({ ...base, marker: { state: 'unreadable' } })).toBe('unknown')
  })
})

describe('classifyWorktreeDirty', () => {
  test('stderr warning with exit 0 is uninspectable — catches treating a permission warning as clean', () => {
    expect(
      classifyWorktreeDirty(
        0,
        '',
        "warning: could not open directory 'secret/': Permission denied\n",
      ),
    ).toEqual({
      dirty: true,
      detail:
        "could not inspect uncommitted or untracked work: warning: could not open directory 'secret/': Permission denied",
    })
  })

  test('clean status is not dirty — catches treating empty porcelain as dirty', () => {
    expect(classifyWorktreeDirty(0, '', '')).toEqual({
      dirty: false,
      detail: 'all work is committed',
    })
  })

  test('porcelain output is dirty — catches ignoring uncommitted or untracked lines', () => {
    expect(classifyWorktreeDirty(0, '?? untracked.txt\n', '')).toEqual({
      dirty: true,
      detail: 'has uncommitted or untracked changes',
    })
  })
})
