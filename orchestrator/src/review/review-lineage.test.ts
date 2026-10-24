import { expect, test } from 'bun:test'
import { type BranchMintFact, branchReviewLineage } from './review-lineage.ts'

const fact = (
  mintedBranch: string,
  launchBase: string | null,
  launchKey = 'DEV-1686',
): BranchMintFact => ({ mintedBranch, launchBase, launchKey })

test('follows direct and transitive same-task minted branch bases', () => {
  expect(
    branchReviewLineage('branch-c', [
      fact('branch-a', 'main'),
      fact('branch-b', 'branch-a'),
      fact('branch-c', 'branch-b'),
    ]),
  ).toEqual(['branch-c', 'branch-b', 'branch-a'])
})

test('stops at a commit sha base', () => {
  expect(
    branchReviewLineage('branch-b', [fact('branch-b', 'abc123'), fact('branch-a', 'main')]),
  ).toEqual(['branch-b'])
})

test('stops before an ancestor minted for a different launch key', () => {
  expect(
    branchReviewLineage('branch-b', [
      fact('branch-a', 'main', 'DEV-OTHER'),
      fact('branch-b', 'branch-a'),
    ]),
  ).toEqual(['branch-b'])
})

test('ends a cycle without revisiting a branch', () => {
  expect(
    branchReviewLineage('branch-b', [fact('branch-a', 'branch-b'), fact('branch-b', 'branch-a')]),
  ).toEqual(['branch-b', 'branch-a'])
})
