import { describe, expect, test } from 'bun:test'
import {
  classifyWorktreeDirty,
  isUnmarkedBorrowedReaderClone,
  type TreeOwnershipInput,
  treeOwnership,
} from './worktree-attribution.ts'
import { readOnlyWorktreePath, sharedReviewWorktreePath } from './worktree-readonly.ts'

describe('isUnmarkedBorrowedReaderClone', () => {
  const runId = '01990000-0000-7000-8000-000000001960'
  const commit = '0123456789abcdef0123456789abcdef01234567'
  const reader = {
    path: readOnlyWorktreePath('/projects/alpha', runId),
    repoRoot: '/projects/alpha',
    borrowedSource: '/projects/alpha',
  }

  test('accepts only a conventional direct child borrowing from this project', () => {
    expect(isUnmarkedBorrowedReaderClone(reader)).toBeTrue()
    expect(
      isUnmarkedBorrowedReaderClone({
        ...reader,
        path: sharedReviewWorktreePath('/projects/alpha', commit),
      }),
    ).toBeTrue()
    expect(
      isUnmarkedBorrowedReaderClone({ ...reader, path: '/projects/alpha/.claude/worktrees/other' }),
    ).toBeFalse()
    expect(
      isUnmarkedBorrowedReaderClone({
        ...reader,
        path: `/projects/alpha/.claude/worktrees/nested/orch-${runId}`,
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
  treeSharerRunIds: [],
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

  test('owns a shared tree for a second recorded sharer only', () => {
    const creator = '42000000-0000-4000-8000-000000000000'
    expect(
      treeOwnership({
        ...base,
        treeSharerRunIds: [creator, '40000000-0000-4000-8000-000000000000'],
        marker: { state: 'present', runRecordId: creator, repoRoot: '/projects/alpha' },
      }),
    ).toBe('owned')
    expect(
      treeOwnership({
        ...base,
        treeSharerRunIds: [creator],
        marker: { state: 'present', runRecordId: creator, repoRoot: '/projects/alpha' },
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
