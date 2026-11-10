import { expect, test } from 'bun:test'
import { trustUsesPinnedSpace } from './machine-trust.ts'

test('machine trust uses pinned-space rotation only for the selected pinned space', () => {
  expect(trustUsesPinnedSpace('space-a', 'space-a')).toBe(true)
  expect(trustUsesPinnedSpace('space-a', 'space-b')).toBe(false)
  expect(trustUsesPinnedSpace(null, 'space-a')).toBe(false)
})
