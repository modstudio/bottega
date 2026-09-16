import { describe, expect, test } from 'bun:test'
import { recordSpaceRole } from './record-space.ts'

describe('record space decisions', () => {
  test('accepts only supported invitation roles', () => {
    expect(recordSpaceRole('member')).toBe('member')
    expect(recordSpaceRole('owner')).toBe('owner')
    expect(() => recordSpaceRole('operator')).toThrow('must be member or owner')
  })
})
