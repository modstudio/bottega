import { describe, expect, test } from 'bun:test'
import {
  classifyAuditOutcome,
  classifyDependencyAudit,
  compareDependencyAudit,
  type DependencyAdvisory,
} from './check-dependency-audit'

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

describe('dependency audit command result', () => {
  test('a real-shaped payload reports its advisories', () => {
    expect(
      classifyDependencyAudit(
        1,
        JSON.stringify({ example: [{ id: 12, severity: 'high', title: 'Example advisory' }] }),
        '',
      ),
    ).toEqual({ kind: 'result', advisories: baseline })
  })

  test('an empty valid result passes', () => {
    expect(classifyDependencyAudit(0, '{}', '')).toEqual({ kind: 'result', advisories: [] })
  })

  test('unparseable output with a nonzero exit fails with what was received', () => {
    expect(classifyDependencyAudit(2, 'not json', 'bun crashed')).toEqual({
      kind: 'failure',
      detail: 'bun audit exited 2; output: not json\nbun crashed',
    })
  })

  test('an offline error is unavailable', () => {
    const stderr =
      'error: POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk - FailedToOpenSocket'
    expect(classifyDependencyAudit(1, '', stderr)).toEqual({
      kind: 'unavailable',
      detail: `bun audit could not reach the advisory service: ${stderr}`,
    })
  })

  test('unparseable output with an accepted exit fails instead of reading as unavailable', () => {
    expect(classifyDependencyAudit(1, 'not json', '')).toEqual({
      kind: 'failure',
      detail: 'bun audit exited 1; output: not json',
    })
  })

  test('a timeout is unavailable', () => {
    expect(classifyAuditOutcome({ kind: 'timeout' })).toEqual({
      kind: 'unavailable',
      detail: 'bun audit exceeded 10000ms and was killed',
    })
  })
})
