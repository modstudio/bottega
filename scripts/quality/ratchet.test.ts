import { describe, expect, test } from 'bun:test'
import { noExpectFindings } from './no-expect'
import { introducedFindings, type Finding } from './ratchet'

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
    expect(introducedFindings([finding(4, 'function has 12 branches')], [
      finding(4, 'function has 9 branches'),
    ])).toEqual([])
  })
})

describe('zero-expect scanner', () => {
  test('reports a test body which cannot reach expect', () => {
    const findings = noExpectFindings('subject.test.ts', `
      test('does work', () => { const value = 1 + 1 })
    `)
    expect(findings.map(({ line, rule }) => ({ line, rule }))).toEqual([
      { line: 2, rule: 'test-reaches-expect' },
    ])
  })

  test('accepts direct and same-file helper expect calls', () => {
    const findings = noExpectFindings('subject.test.ts', `
      const checks = () => expect(true).toBe(true)
      test('direct', () => expect(true).toBe(true))
      test('helper', checks)
    `)
    expect(findings).toEqual([])
  })
})
