import { describe, expect, test } from 'bun:test'
import { type TreeOwnershipInput, treeOwnership } from './worktree-attribution.ts'

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
