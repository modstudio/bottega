import { expect, test } from 'bun:test'
import { nextLensProfileVersion } from './lens-profile-version.ts'

test.each([
  { current: 2, revisions: [], expected: 3 },
  { current: 3, revisions: [1, 2], expected: 4 },
  { current: 2, revisions: [1, 3], expected: 4 },
])('next profile version for current $current and revisions $revisions is $expected', (row) => {
  expect(nextLensProfileVersion(row.current, row.revisions)).toBe(row.expected)
})
