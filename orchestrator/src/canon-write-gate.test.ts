import { describe, expect, test } from 'bun:test'
import { decideCanonWrite } from './canon-write-gate.ts'

const inputs = { trackedPaths: [], packageScripts: [], sourceTexts: [] }

describe('decideCanonWrite', () => {
  test('refuses an introduced history line', () => {
    const findings = decideCanonWrite({
      ...inputs,
      current: [{ slug: 'AGENTS.md', body: 'Current rule.' }],
      next: [{ slug: 'AGENTS.md', body: 'Current rule.\nIt used to be different.' }],
    })
    expect(findings.map(({ rule }) => rule)).toContain('canon/history')
  })

  test('allows removing a numeral', () => {
    expect(
      decideCanonWrite({
        ...inputs,
        current: [{ slug: 'AGENTS.md', body: 'Keep 123 items.' }],
        next: [{ slug: 'AGENTS.md', body: 'Keep items.' }],
      }),
    ).toEqual([])
  })

  test('refuses growth of an already over-cap file', () => {
    const current = `${'x'.repeat(16_385)}\n`
    const findings = decideCanonWrite({
      ...inputs,
      current: [{ slug: 'AGENTS.md', body: current }],
      next: [{ slug: 'AGENTS.md', body: `${current}more` }],
    })
    expect(findings.map(({ rule }) => rule)).toContain('canon/size-entry')
  })
})
