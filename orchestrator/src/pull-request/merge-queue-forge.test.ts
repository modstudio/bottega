import { expect, test } from 'bun:test'
import { enqueuePullRequestArguments } from './merge-queue-forge.ts'

test('merge-queue enqueue leaves merge method and subject to the queue', () => {
  expect(enqueuePullRequestArguments(42, 'head-commit')).toEqual([
    'gh',
    'pr',
    'merge',
    '42',
    '--auto',
    '--match-head-commit',
    'head-commit',
  ])
})
