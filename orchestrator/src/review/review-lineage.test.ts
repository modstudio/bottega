import { expect, test } from 'bun:test'
import { type BranchMintFact, branchReviewLineage } from './review-lineage.ts'

const fact = (
  mintedBranch: string,
  launchBase: string | null,
  launchKey = 'DEV-1686',
  headCommit: string | null = null,
): BranchMintFact => ({ mintedBranch, launchBase, launchKey, headCommit })

test('follows direct and transitive same-task minted branch bases', () => {
  expect(
    branchReviewLineage('branch-c', [
      fact('branch-a', 'main'),
      fact('branch-b', 'branch-a'),
      fact('branch-c', 'branch-b'),
    ]),
  ).toEqual(['branch-c', 'branch-b', 'branch-a'])
})

test('follows a commit sha base into the same-task run whose tip it names', () => {
  const head = 'abc1234def567890abc1234def567890abc1234d'
  expect(
    branchReviewLineage('branch-b', [
      fact('branch-b', head),
      fact('branch-a', 'main', 'DEV-1686', head),
    ]),
  ).toEqual(['branch-b', 'branch-a'])
})

test('follows an unambiguous short sha base into the same-task run tip', () => {
  expect(
    branchReviewLineage('branch-b', [
      fact('branch-b', '512aaa9'),
      fact('branch-a', 'main', 'DEV-1686', '512aaa9def567890abc1234def567890abc1234d'),
    ]),
  ).toEqual(['branch-b', 'branch-a'])
})

test('ignores another task at the same tip when following a sha base', () => {
  const head = '512aaa9def567890abc1234def567890abc1234d'
  expect(
    branchReviewLineage('branch-b', [
      fact('branch-b', '512aaa9'),
      fact('branch-a', 'main', 'DEV-1686', head),
      fact('other-task-branch', 'main', 'DEV-OTHER', head),
    ]),
  ).toEqual(['branch-b', 'branch-a'])
})

test('deduplicates rows for one branch when following a sha base', () => {
  const head = '512aaa9def567890abc1234def567890abc1234d'
  expect(
    branchReviewLineage('branch-b', [
      fact('branch-b', '512aaa9'),
      fact('branch-a', 'main', 'DEV-1686', head),
      fact('branch-a', 'main', 'DEV-1686', head),
    ]),
  ).toEqual(['branch-b', 'branch-a'])
})

test('excludes the descendant itself when following a sha base', () => {
  const head = '512aaa9def567890abc1234def567890abc1234d'
  expect(
    branchReviewLineage('branch-b', [
      fact('branch-b', '512aaa9', 'DEV-1686', head),
      fact('branch-a', 'main', 'DEV-1686', head),
    ]),
  ).toEqual(['branch-b', 'branch-a'])
})

test('does not follow an ambiguous short sha base', () => {
  expect(
    branchReviewLineage('branch-c', [
      fact('branch-c', '512aaa9'),
      fact('branch-a', 'main', 'DEV-1686', '512aaa9def567890abc1234def567890abc1234d'),
      fact('branch-b', 'main', 'DEV-1686', '512aaa9000567890abc1234def567890abc1234d'),
    ]),
  ).toEqual(['branch-c'])
})

test('does not follow a commit sha tip from another task', () => {
  const head = 'abc1234def567890abc1234def567890abc1234d'
  expect(
    branchReviewLineage('branch-b', [
      fact('branch-b', head),
      fact('branch-a', 'main', 'DEV-OTHER', head),
    ]),
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

test('follows a qualified branch base', () => {
  expect(
    branchReviewLineage('branch-b', [
      fact('branch-a', 'main'),
      fact('branch-b', 'refs/heads/branch-a'),
    ]),
  ).toEqual(['branch-b', 'branch-a'])
})
