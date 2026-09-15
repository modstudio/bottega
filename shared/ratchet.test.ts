import { describe, expect, test } from 'bun:test'
import { type Finding, introducedFindings } from './ratchet'

const finding = (line: number, message = 'test reaches 0 expect() calls'): Finding => ({
  file: 'example.test.ts',
  line,
  rule: 'test-reaches-expect',
  message,
})

describe('quality finding ratchet', () => {
  test('a finding present at base and head is not reported', () => {
    expect(introducedFindings([finding(4)], [finding(4)])).toEqual([])
  })

  test('a finding only at head is reported with its location', () => {
    expect(introducedFindings([], [finding(9)])).toEqual([finding(9)])
  })

  test('a finding which moved lines is not reported', () => {
    expect(introducedFindings([finding(4)], [finding(40)])).toEqual([])
  })

  test('a decreased count in the message is not reported', () => {
    expect(
      introducedFindings(
        [finding(4, 'function has 12 branches')],
        [finding(4, 'function has 9 branches')],
      ),
    ).toEqual([])
  })
})
