import { describe, expect, test } from 'bun:test'
import { decideRunLeftover, type RunLeftoverFacts } from './run-leftover-decision.ts'

const day = 24 * 60 * 60 * 1000
const clock = Date.parse('2026-10-18T12:00:00.000Z')
const old = clock - 3 * day - 1
const recent = clock - 3 * day

function facts(overrides: Partial<RunLeftoverFacts>): RunLeftoverFacts {
  return {
    kind: 'scratch',
    runStatus: 'ok',
    finishedAt: old,
    judged: true,
    newestEntryAt: old,
    clock,
    ...overrides,
  }
}

describe('scheduled run leftover decision', () => {
  test('keeps a live run', () => {
    expect(decideRunLeftover(facts({ runStatus: 'running' }))).toEqual({
      action: 'keep',
      reason: 'run is live (running)',
    })
  })

  test('keeps a recent terminal run', () => {
    expect(decideRunLeftover(facts({ finishedAt: recent }))).toEqual({
      action: 'keep',
      reason: 'run is not older than the run leftover age cap',
    })
  })

  test('removes every directory kind of an old judged run', () => {
    for (const kind of ['scratch', 'sandbox', 'isolate', 'artifacts'] as const) {
      expect(decideRunLeftover(facts({ kind }))).toEqual({
        action: 'remove',
        reason: 'terminal run is older than the run leftover age cap',
      })
    }
  })

  test('keeps and names old unjudged artifacts', () => {
    expect(decideRunLeftover(facts({ kind: 'artifacts', judged: false }))).toEqual({
      action: 'keep',
      reason: 'run has no recorded verdict',
      remedy: 'score',
    })
  })

  test('removes an old orphan', () => {
    expect(
      decideRunLeftover(
        facts({ kind: 'orphan', runStatus: null, finishedAt: null, newestEntryAt: old }),
      ),
    ).toEqual({ action: 'remove', reason: 'orphan is older than the run leftover age cap' })
  })

  test('keeps a young orphan', () => {
    expect(
      decideRunLeftover(
        facts({ kind: 'orphan', runStatus: null, finishedAt: null, newestEntryAt: recent }),
      ),
    ).toEqual({ action: 'keep', reason: 'orphan is not older than the run leftover age cap' })
  })
})
