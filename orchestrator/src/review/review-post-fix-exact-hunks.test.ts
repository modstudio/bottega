import { expect, test } from 'bun:test'
import {
  type PerPathPatch,
  type RebaseFileComparison,
  rebaseCarryDecision,
} from './review-post-fix.ts'

const patch = (patchId: string): PerPathPatch => ({
  path: 'src/shared.ts',
  patchId,
  insertions: 1,
  deletions: 1,
})

const comparison = (input: {
  conflicted: boolean
  exactHunks: boolean
  samePatch: boolean
  trunkChanged?: boolean
}): RebaseFileComparison => ({
  path: 'src/shared.ts',
  replayed: patch('reviewed'),
  current: patch(input.samePatch ? 'reviewed' : 'current'),
  conflicted: input.conflicted,
  trunkChanged: input.trunkChanged ?? input.conflicted,
  exactHunks: input.exactHunks,
})

test.each([
  {
    name: 'a conflicted file with exact hunks carries',
    input: { conflicted: true, exactHunks: true, samePatch: false },
    changed: false,
  },
  {
    name: 'a conflicted file with different hunks is re-owed',
    input: { conflicted: true, exactHunks: false, samePatch: false },
    changed: true,
  },
  {
    name: 'a non-conflicted file with a different patch is re-owed',
    input: { conflicted: false, exactHunks: false, samePatch: false, trunkChanged: true },
    changed: true,
  },
  {
    name: 'a non-conflicted file with the same patch carries',
    input: { conflicted: false, exactHunks: false, samePatch: true },
    changed: false,
  },
])('$name', ({ input, changed }) => {
  expect(
    rebaseCarryDecision({
      files: [comparison(input)],
      pathsByLens: { correctness: ['src/shared.ts'] },
    }),
  ).toEqual(
    changed
      ? {
          fixFiles: [{ path: 'src/shared.ts', insertions: 1, deletions: 1 }],
          reOwedPathsByLens:
            input.conflicted || input.trunkChanged ? { correctness: ['src/shared.ts'] } : {},
        }
      : { fixFiles: [], reOwedPathsByLens: {} },
  )
})
