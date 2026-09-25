import { describe, expect, test } from 'bun:test'
import { composeCanonRows } from './canon-hydrate.ts'
import { decideCanonWrite, decideUserCanonImport } from './canon-write-gate.ts'

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

  test('counts repository and user entry rows in the combined always-on budget', () => {
    const body = 'x'.repeat(16_000)
    const rule = { slug: '.agents/rules/example.md', body: 'x'.repeat(1_000) }
    const composed = composeCanonRows(
      [{ subject: null, slug: 'AGENTS.md', body }],
      [{ subject: null, owner: 'user-1', slug: 'AGENTS.md', body }],
      [],
    ).map(({ slug, body: rowBody }) => ({ slug, body: rowBody }))
    const findings = decideCanonWrite({
      ...inputs,
      current: [{ slug: 'AGENTS.md', body }, rule],
      next: [...composed, rule],
    })
    expect(findings.map(({ rule }) => rule)).toContain('canon/size-always-on')
  })
})

describe('decideUserCanonImport', () => {
  test('allows an empty owner to bootstrap and returns all findings', () => {
    const decision = decideUserCanonImport({
      current: [],
      next: [{ slug: 'AGENTS.md', body: 'Keep 123 things. It used to differ.' }],
    })
    expect(decision.bootstrap).toBe(true)
    expect(decision.findings.map(({ rule }) => rule)).toContain('canon/numeral')
    expect(decision.findings.map(({ rule }) => rule)).toContain('canon/history')
  })

  test('does not bootstrap a non-empty owner and returns introduced findings', () => {
    const decision = decideUserCanonImport({
      current: [{ slug: 'AGENTS.md', body: 'Current rule.' }],
      next: [{ slug: 'AGENTS.md', body: 'Current rule. It used to differ.' }],
    })
    expect(decision.bootstrap).toBe(false)
    expect(decision.findings.map(({ rule }) => rule)).toContain('canon/history')
  })
})
