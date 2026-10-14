import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { executionRequirementRefusal } from './execution-requirement.ts'

test('declared execution refuses a reader tree and otherwise proceeds', () => {
  expect(
    executionRequirementRefusal({
      declared: true,
      job: 'review-lens',
      lens: 'correctness',
      treeKind: 'reader',
    }),
  ).toBe(
    `refused: review-lens/correctness requires execution, and a review-lens run gets a reader tree with no database, containers or server. Run the proof in a tree that can execute it — ${PLATFORM_SLUG} tree open <run> on the change's finished run, then serve it with the project's worktree serve command — or drop --requires-execution if the review can be answered by reading.`,
  )
  expect(
    executionRequirementRefusal({
      declared: true,
      job: 'implement',
      treeKind: 'writer',
    }),
  ).toBeNull()
  expect(
    executionRequirementRefusal({
      declared: false,
      job: 'review-lens',
      treeKind: 'reader',
    }),
  ).toBeNull()
})
