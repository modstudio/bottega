import { describe, expect, test } from 'bun:test'
import { compareDependencyAudit, type DependencyAdvisory } from './check-dependency-audit'

const baseline = [{ id: 12, package: 'example' }] satisfies DependencyAdvisory[]

describe('dependency audit baseline', () => {
  test('a new advisory fails the ratchet', () => {
    expect(
      compareDependencyAudit([...baseline, { id: 34, package: 'new-package' }], baseline),
    ).toEqual({
      introduced: [{ id: 34, package: 'new-package' }],
      stale: [],
    })
  })

  test('a baseline advisory passes the ratchet', () => {
    expect(compareDependencyAudit(baseline, baseline)).toEqual({ introduced: [], stale: [] })
  })

  test('an advisory no longer reported is stale', () => {
    expect(compareDependencyAudit([], baseline)).toEqual({ introduced: [], stale: baseline })
  })
})
