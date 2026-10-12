import { describe, expect, test } from 'bun:test'
import { ESLint } from 'eslint'
import { changedComplexityViolations, complexityFindings } from './check-cognitive-ceiling'

function complexFunction(name: string, branches: number) {
  const conditions = Array.from(
    { length: branches },
    (_, index) => `  if (value === ${index}) value += 1`,
  )
  return [`function ${name}(value: number) {`, ...conditions, '  return value', '}'].join('\n')
}

describe('changed cognitive complexity check', () => {
  test('lints supplied content and refuses grown and new functions', async () => {
    const path = 'scripts/complexity-wiring-fixture.ts'
    const unchanged = complexFunction('unchanged', 16)
    const base = [complexFunction('grown', 16), unchanged].join('\n\n')
    const head = [complexFunction('grown', 17), unchanged, complexFunction('added', 16)].join(
      '\n\n',
    )
    const view = {
      entries: [{ status: 'M' as const, path }],
      facts: { renames: new Map<string, string>(), addedLines: new Map() },
      baseContent: () => ({ status: 'present' as const, text: base }),
      headContent: () => ({ status: 'present' as const, text: head }),
    }

    const violations = await changedComplexityViolations(
      new ESLint({ cwd: process.cwd() }),
      view,
      new Set([path]),
    )

    expect(violations).toHaveLength(2)
    expect(violations).toContainEqual(
      expect.stringContaining(`${path}:1 grown: complexity 17, limit 15, previous score 16`),
    )
    expect(violations).toContainEqual(expect.stringContaining(`${path}:42 added: complexity 16`))
    expect(violations.every((violation) => !violation.includes('unchanged'))).toBe(true)
  })
})

describe('complexity finding names', () => {
  test('derives declarations, variables, methods, callbacks, and duplicate names from text', () => {
    const text = [
      'function declared() { return 1 }',
      'const assigned = () => 2',
      'const holder = { method() { return 3 } }',
      'items.map(() => true)',
      'const one = function duplicate() { return 1 }',
      'const two = function duplicate() { return 2 }',
    ].join('\n')
    const messages = [1, 2, 3, 4, 5, 6].map((line, index) => ({
      ruleId: 'sonarjs/cognitive-complexity',
      severity: 2,
      line,
      column: [1, 18, 18, 11, 13, 13][index],
      message:
        'Refactor this function to reduce its Cognitive Complexity from 16 to the 15 allowed.',
    }))

    expect(complexityFindings('names.ts', text, messages).map(({ symbol }) => symbol)).toEqual([
      'declared',
      'assigned',
      'method',
      'map callback',
      'duplicate#1',
      'duplicate#2',
    ])
  })
})
