import { expect, test } from 'bun:test'
import { machineTrustLines, trustUsesPinnedSpace } from './machine-trust.ts'

test('machine trust uses pinned-space rotation only for the selected pinned space', () => {
  expect(trustUsesPinnedSpace('space-a', 'space-a')).toBe(true)
  expect(trustUsesPinnedSpace('space-a', 'space-b')).toBe(false)
  expect(trustUsesPinnedSpace(null, 'space-a')).toBe(false)
})

test('machine trust prints an idempotent result before the key id', () => {
  expect(machineTrustLines(0, 'machine-key')).toEqual(['already trusted', 'machine-key'])
  expect(machineTrustLines(1, 'machine-key')).toEqual(['machine-key'])
})
