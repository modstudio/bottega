import { expect, test } from 'bun:test'
import { isSpaceOwner } from './record-member-permission.ts'

test('only the owner role is an owner, so its write permission stays protected', () => {
  expect(isSpaceOwner('owner')).toBe(true)
  expect(isSpaceOwner('admin')).toBe(false)
  expect(isSpaceOwner('member')).toBe(false)
})
