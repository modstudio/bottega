import { expect, test } from 'bun:test'
import { changeComparisonLines } from './check-review-change-comparisons.ts'

test('refuses change-identity comparisons in TypeScript and SQL spellings', () => {
  const source = [
    'a.patchId === b.patchId',
    'read.patch_id === patchId',
    'row.review_patch_id === current.patchId',
    'a.zeroContextPatchId === b.zeroContextPatchId',
    'AND r.zero_context_patch_id = c.zero_context_patch_id',
    'WHERE r.patch_id = c.patch_id',
  ].join('\n')

  expect(changeComparisonLines(source)).toEqual([1, 2, 3, 4, 5, 6])
})

test('allows assigning a stored identity to a field', () => {
  const source = [
    'patchId: row.patch_id',
    'patch_id=excluded.patch_id',
    'zero_context_patch_id=excluded.zero_context_patch_id',
  ].join('\n')
  expect(changeComparisonLines(source)).toEqual([])
})
