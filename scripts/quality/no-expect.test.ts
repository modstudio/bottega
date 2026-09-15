import { describe, expect, test } from 'bun:test'
import { noExpectFindings } from './no-expect'

describe('zero-expect scanner', () => {
  test('reports a test body which cannot reach expect', () => {
    const findings = noExpectFindings(
      'subject.test.ts',
      `
      test('does work', () => { const value = 1 + 1 })
    `,
    )
    expect(findings.map(({ line, rule }) => ({ line, rule }))).toEqual([
      { line: 2, rule: 'test-reaches-expect' },
    ])
  })

  test('accepts direct and same-file helper expect calls', () => {
    const findings = noExpectFindings(
      'subject.test.ts',
      `
      const checks = () => expect(true).toBe(true)
      test('direct', () => expect(true).toBe(true))
      test('helper', checks)
    `,
    )
    expect(findings).toEqual([])
  })
})
