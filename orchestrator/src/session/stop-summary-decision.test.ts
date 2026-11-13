import { describe, expect, test } from 'bun:test'
import {
  decideStopSummary,
  OWED_ITEM_OVERDUE_MS,
  type StopSummaryFacts,
  stopSummaryBlockKey,
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
  kind: 'run' as const,
  identity: 'run-12',
  label: 'run 12 implement DEV-2297 unscored',
  command: 'bottega score 12 (see bottega score --help)',
  owedAt: new Date(Date.parse(NOW) - age).toISOString(),
})

describe('Stop summary decision', () => {
  test('nothing pending is exactly the quiet line', () => {
    expect(decideStopSummary(facts())).toEqual({
      lines: ['Nothing waiting on you'],
      block: false,
      reason: null,
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
      '2 questions waiting on you → bottega question inbox',
      'DEV-2297 · plan-task · step design (6 of 11)',
      'explore · step orient (1 of 4)',
    ])
    expect(result.lines.join('\n')).not.toContain('question text')
    expect(result.lines.join('\n')).not.toContain('workflow step')
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
      'run 12 implement DEV-2297 unscored → bottega score 12 (see bottega score --help)',
    )
  })

  test('idle owed items block once, then collapse until the set changes', () => {
    const first = decideStopSummary(facts({ owedItems: [owed()] }))
    expect(first.block).toBe(true)
    expect(first.lines.at(-1)).toContain('run 12 implement DEV-2297 unscored')
    const second = decideStopSummary(
      facts({ owedItems: [owed()], previousBlockKey: stopSummaryBlockKey(first.reason!) }),
    )
    expect(second.block).toBe(false)
    expect(second.lines.at(-1)).toBe('1 item owed → bottega score pending')
  })
})
