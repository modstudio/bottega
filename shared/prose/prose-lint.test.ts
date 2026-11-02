import { describe, expect, test } from 'bun:test'
import { lintProse } from './prose-lint.ts'

const rules = (text: string) => lintProse(text).map(({ rule }) => rule)

describe('shared prose rules', () => {
  test('finds task keys, history phrases, numerals, and ISO dates', () => {
    expect(rules('DEV-880\nThis was called old.\nThere are 5 paths.\nOn 2026-09-23.')).toEqual([
      'issue',
      'history',
      'numeral',
      'date',
    ])
  })

  test('keeps task-key and code exemptions', () => {
    expect(
      lintProse(
        'UTF-8 SHA-256 ISO-8601 RFC-3339 ES-2024 TLS-13 HTTP-2 IPV-6\n' +
          '`2026-09-23 and 5`\n```\nDEV-880 was formerly 5 on 2026-09-23\n```',
      ),
    ).toEqual([])
  })

  test('does not treat YAML frontmatter as prose', () => {
    expect(lintProse('---\nwritten: 2026-09-23T00:00:00Z\ncount: 5\n---\nCurrent.')).toEqual([])
  })
})
