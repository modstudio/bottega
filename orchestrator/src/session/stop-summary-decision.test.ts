import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  decideStopSummary,
  OWED_ITEM_OVERDUE_MS,
  type StopSummaryFacts,
} from './stop-summary-decision.ts'

const NOW = '2026-11-13T12:00:00.000Z'
const facts = (overrides: Partial<StopSummaryFacts> = {}): StopSummaryFacts => ({
  now: NOW,
  questionCount: 0,
  cursors: [],
  liveRuns: 0,
  incompleteReviews: 0,
  inFlightLandings: 0,
  owedItems: [],
  previousBlockKey: null,
  ...overrides,
})
const owed = (age = 0) => ({
  label: 'run 12 implement DEV-2297 unscored',
  command: `${PLATFORM_SLUG} score 12 (see ${PLATFORM_SLUG} score --help)`,
  owedAt: new Date(Date.parse(NOW) - age).toISOString(),
})

describe('Stop summary decision', () => {
  test('nothing pending is exactly the quiet line', () => {
    expect(decideStopSummary(facts())).toEqual({
      lines: ['Nothing waiting on you'],
      block: false,
      reason: null,
      blockKey: null,
    })
  })

  test('questions lead and cursors stay short, including keyless explore', () => {
    const result = decideStopSummary(
      facts({
        questionCount: 2,
        cursors: [
          { key: 'DEV-2297', workflow: 'plan-task', step: 'design', ordinal: 6, total: 11 },
          { key: null, workflow: 'explore', step: 'orient', ordinal: 1, total: 4 },
        ],
      }),
    )
    expect(result.lines).toEqual([
      `2 questions waiting on you → ${PLATFORM_SLUG} question inbox`,
      'DEV-2297 · plan-task · step design (6 of 11)',
      'explore · step orient (1 of 4)',
    ])
  })

  test('work in motion is one line and hides fresh owed items', () => {
    expect(
      decideStopSummary(
        facts({ liveRuns: 2, incompleteReviews: 1, inFlightLandings: 1, owedItems: [owed()] }),
      ).lines,
    ).toEqual(['Nothing waiting on you', 'In progress: 2 runs, 1 review round, 1 landing'])
  })

  test('an overdue item prints while work moves without blocking', () => {
    const result = decideStopSummary(
      facts({ liveRuns: 1, owedItems: [owed(OWED_ITEM_OVERDUE_MS)] }),
    )
    expect(result.block).toBe(false)
    expect(result.lines.at(-1)).toBe(
      `run 12 implement DEV-2297 unscored → ${PLATFORM_SLUG} score 12 (see ${PLATFORM_SLUG} score --help)`,
    )
  })

  test('idle owed items block once, then collapse until the set changes', () => {
    const first = decideStopSummary(facts({ owedItems: [owed()] }))
    expect(first.block).toBe(true)
    expect(first.blockKey).toBeString()
    expect(first.lines.at(-1)).toContain('run 12 implement DEV-2297 unscored')
    const second = decideStopSummary(
      facts({ owedItems: [owed()], previousBlockKey: first.blockKey }),
    )
    expect(second.block).toBe(false)
    expect(second.blockKey).toBe(first.blockKey)
    expect(second.lines.at(-1)).toBe(`1 item owed → ${PLATFORM_SLUG} score pending`)

    const added = {
      ...owed(),
      label: 'run 13 review DEV-2297 unscored',
      command: `${PLATFORM_SLUG} score 13 (see ${PLATFORM_SLUG} score --help)`,
    }
    const changed = decideStopSummary(
      facts({ owedItems: [owed(), added], previousBlockKey: first.blockKey }),
    )
    expect(changed.block).toBe(true)
    expect(changed.lines.slice(-2)).toEqual([
      `run 12 implement DEV-2297 unscored → ${PLATFORM_SLUG} score 12 (see ${PLATFORM_SLUG} score --help)`,
      `run 13 review DEV-2297 unscored → ${PLATFORM_SLUG} score 13 (see ${PLATFORM_SLUG} score --help)`,
    ])

    const shrunk = decideStopSummary(
      facts({ owedItems: [added], previousBlockKey: changed.blockKey }),
    )
    expect(shrunk.block).toBe(true)
    expect(shrunk.lines.at(-1)).toContain('run 13 review DEV-2297 unscored')
  })
})
