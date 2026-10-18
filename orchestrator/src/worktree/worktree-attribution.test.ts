import { describe, expect, test } from 'bun:test'
import {
  classifyWorktreeDirty,
  isUnmarkedBorrowedReaderClone,
  type TreeOwnershipInput,
  treeOwnership,
} from './worktree-attribution.ts'

describe('isUnmarkedBorrowedReaderClone', () => {
  const reader = {
    path: '/projects/alpha/.claude/worktrees/orch-42',
    repoRoot: '/projects/alpha',
    borrowedSource: '/projects/alpha',
  }

  test('accepts only a conventional direct child borrowing from this project', () => {
    expect(isUnmarkedBorrowedReaderClone(reader)).toBeTrue()
    expect(
      isUnmarkedBorrowedReaderClone({ ...reader, path: '/projects/alpha/.claude/worktrees/other' }),
    ).toBeFalse()
    expect(
      isUnmarkedBorrowedReaderClone({
        ...reader,
        path: '/projects/alpha/.claude/worktrees/nested/orch-42',
      }),
    ).toBeFalse()
    expect(
      isUnmarkedBorrowedReaderClone({ ...reader, borrowedSource: '/projects/bravo' }),
    ).toBeFalse()
  })
})

const base: TreeOwnershipInput = {
  conversationRunIds: [
    '40000000-0000-4000-8000-000000000000',
    '41000000-0000-4000-8000-000000000000',
  ],
  repoRoot: '/projects/alpha',
  checkout: true,
  marker: { state: 'absent' },
}

describe('treeOwnership', () => {
  test('owns a marker naming any turn in the conversation', () => {
    expect(
      treeOwnership({
        ...base,
        marker: {
          state: 'present',
          runRecordId: '41000000-0000-4000-8000-000000000000',
          repoRoot: '/projects/alpha',
        },
      }),
    ).toBe('owned')
  })

  test('attaches a marker naming another run', () => {
    expect(
      treeOwnership({
        ...base,
        marker: {
          state: 'present',
          runRecordId: '42000000-0000-4000-8000-000000000000',
          repoRoot: '/projects/alpha',
        },
      }),
    ).toBe('attached')
  })

  test('attaches a marker naming the conversation under another repository', () => {
    expect(
      treeOwnership({
        ...base,
        marker: {
          state: 'present',
          runRecordId: '40000000-0000-4000-8000-000000000000',
          repoRoot: '/projects/starship',
        },
      }),
    ).toBe('attached')
  })

  test('does not infer ownership from a legacy numeric directory name', () => {
    expect(treeOwnership(base)).toBe('attached')
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
