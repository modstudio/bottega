import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  decideStopSummary,
  KEYLESS_CURSOR_IDLE_MS,
  OWED_ITEM_OVERDUE_MS,
  type StopSummaryFacts,
} from './stop-summary-decision.ts'

const NOW = '2026-11-13T12:00:00.000Z'
const SAID = 'Stop says: 7:00 AM EST'
const facts = (overrides: Partial<StopSummaryFacts> = {}): StopSummaryFacts => ({
  now: NOW,
  displayTimezone: 'America/New_York',
  questionCounts: { worker: 0, user: 0, foreign: 0, unowned: 0 },
  cursors: [],
  reviewVerdictLines: [],
  liveRuns: 0,
  incompleteReviews: 0,
  inFlightLandings: 0,
  owedItems: [],
  previousBlockKey: null,
  ...overrides,
})
const owed = (age = 0) => ({
  kind: 'unscored-run',
  noun: 'unscored run',
  qualifier: 'implement, DEV-2297',
  id: '12',
  command: `${PLATFORM_SLUG} score <run>`,
  owedAt: new Date(Date.parse(NOW) - age).toISOString(),
})

describe('Stop summary decision', () => {
  test('nothing pending is exactly the quiet line', () => {
    expect(decideStopSummary(facts())).toEqual({
      lines: [SAID, 'Nothing waiting on you'],
      block: false,
      reason: null,
      blockKey: null,
    })
  })

  test('questions lead and cursors stay short, including keyless explore', () => {
    const result = decideStopSummary(
      facts({
        questionCounts: { worker: 0, user: 2, foreign: 0, unowned: 0 },
        cursors: [
          {
            number: 10,
            key: 'DEV-2297',
            workflow: 'plan-task',
            step: 'design',
            ordinal: 6,
            total: 11,
            updatedAt: NOW,
          },
          {
            number: 11,
            key: null,
            workflow: 'explore',
            step: 'orient',
            ordinal: 1,
            total: 4,
            updatedAt: NOW,
          },
        ],
      }),
    )
    expect(result.lines).toEqual([
      SAID,
      `2 rulings waiting on you → ${PLATFORM_SLUG} question inbox`,
      'DEV-2297 · plan-task · step design (6 of 11)',
      'explore · step orient (1 of 4)',
    ])
  })

  test('an idle keyless cursor adds one non-blocking line without changing block identity', () => {
    const idleCursor = {
      number: 845,
      key: null,
      workflow: 'explore',
      step: 'orient',
      ordinal: 1,
      total: 4,
      updatedAt: new Date(Date.parse(NOW) - KEYLESS_CURSOR_IDLE_MS).toISOString(),
    }
    const baseline = decideStopSummary(facts({ owedItems: [owed()] }))
    const result = decideStopSummary(facts({ cursors: [idleCursor], owedItems: [owed()] }))

    expect(result.lines.filter((line) => line.startsWith('Explore cursor 845 idle'))).toEqual([
      `Explore cursor 845 idle 1h 0m → ${PLATFORM_SLUG} workflow abandon --cursor 845`,
    ])
    expect(result.block).toBeTrue()
    expect(result.blockKey).toBe(baseline.blockKey)
  })

  test('fresh and task-bound cursors never add an idle close line', () => {
    const old = new Date(Date.parse(NOW) - KEYLESS_CURSOR_IDLE_MS).toISOString()
    const cursors = [
      {
        number: 845,
        key: null,
        workflow: 'explore',
        step: 'orient',
        ordinal: 1,
        total: 4,
        updatedAt: NOW,
      },
      {
        number: 884,
        key: 'DEV-2323',
        workflow: 'plan-task',
        step: 'build',
        ordinal: 1,
        total: 4,
        updatedAt: old,
      },
    ]
    expect(decideStopSummary(facts({ cursors })).lines).not.toContainEqual(
      expect.stringContaining('workflow abandon --cursor'),
    )
  })

  test('worker and operator questions use their own lines while other groups stay quiet', () => {
    expect(
      decideStopSummary(facts({ questionCounts: { worker: 1, user: 1, foreign: 2, unowned: 3 } }))
        .lines,
    ).toEqual([
      SAID,
      `1 worker question for this session → ${PLATFORM_SLUG} question inbox`,
      `1 ruling waiting on you → ${PLATFORM_SLUG} question inbox`,
    ])
    expect(
      decideStopSummary(facts({ questionCounts: { worker: 0, user: 0, foreign: 2, unowned: 3 } }))
        .lines,
    ).toEqual([SAID, 'Nothing waiting on you'])
  })

  test('an unreadable inbox is never presented as empty', () => {
    expect(decideStopSummary(facts({ questionCounts: null })).lines).toEqual([
      SAID,
      `Could not read question inbox → ${PLATFORM_SLUG} question inbox --all --active`,
    ])
  })

  test('work in motion is one line and hides fresh owed items', () => {
    expect(
      decideStopSummary(
        facts({ liveRuns: 2, incompleteReviews: 1, inFlightLandings: 1, owedItems: [owed()] }),
      ).lines,
    ).toEqual([SAID, 'Nothing waiting on you', 'In progress: 2 runs, 1 review round, 1 landing'])
  })

  test('an overdue item prints while work moves without blocking', () => {
    const result = decideStopSummary(
      facts({ liveRuns: 1, owedItems: [owed(OWED_ITEM_OVERDUE_MS)] }),
    )
    expect(result.block).toBe(false)
    expect(result.lines.at(-1)).toBe(
      `1 unscored run (implement, DEV-2297): 12 → ${PLATFORM_SLUG} score <run>`,
    )
  })

  test('idle owed items block once, then collapse until the set changes', () => {
    const first = decideStopSummary(facts({ owedItems: [owed()] }))
    expect(first.block).toBe(true)
    expect(first.blockKey).toBeString()
    expect(first.lines.at(-1)).toContain('1 unscored run (implement, DEV-2297): 12')
    const second = decideStopSummary(
      facts({ owedItems: [owed()], previousBlockKey: first.blockKey }),
    )
    expect(second.block).toBe(false)
    expect(second.blockKey).toBe(first.blockKey)
    expect(second.lines.at(-1)).toBe(`1 item owed → ${PLATFORM_SLUG} score pending`)

    const added = {
      ...owed(),
      qualifier: 'review, DEV-2297',
      id: '13',
    }
    const changed = decideStopSummary(
      facts({ owedItems: [owed(), added], previousBlockKey: first.blockKey }),
    )
    expect(changed.block).toBe(true)
    expect(changed.lines.slice(-2)).toEqual([
      `1 unscored run (implement, DEV-2297): 12 → ${PLATFORM_SLUG} score <run>`,
      `1 unscored run (review, DEV-2297): 13 → ${PLATFORM_SLUG} score <run>`,
    ])

    const shrunk = decideStopSummary(
      facts({ owedItems: [added], previousBlockKey: changed.blockKey }),
    )
    expect(shrunk.block).toBe(true)
    expect(shrunk.lines.at(-1)).toContain('1 unscored run (review, DEV-2297): 13')
  })

  test('groups every id by kind and qualifier and prints one command template', () => {
    const reviewLensRuns = Array.from({ length: 12 }, (_, index) => ({
      ...owed(),
      qualifier: 'review-lens, DEV-2304',
      id: String(35359 + index),
    }))
    const result = decideStopSummary(facts({ owedItems: reviewLensRuns }))

    expect(result.lines.at(-1)).toBe(
      `12 unscored runs (review-lens, DEV-2304): ${reviewLensRuns.map((item) => item.id).join(', ')} → ${PLATFORM_SLUG} score <run>`,
    )
  })

  test('keeps different kinds and different job qualifiers on separate lines', () => {
    const result = decideStopSummary(
      facts({
        owedItems: [
          owed(),
          { ...owed(), id: '13', qualifier: 'review-lens, DEV-2297' },
          {
            ...owed(),
            kind: 'held-worktree',
            noun: 'held worktree',
            qualifier: 'implement',
            id: '14',
            command: `${PLATFORM_SLUG} run close-out <run>`,
          },
        ],
      }),
    )
    expect(result.lines.slice(-3)).toEqual([
      `1 unscored run (implement, DEV-2297): 12 → ${PLATFORM_SLUG} score <run>`,
      `1 unscored run (review-lens, DEV-2297): 13 → ${PLATFORM_SLUG} score <run>`,
      `1 held worktree (implement): 14 → ${PLATFORM_SLUG} run close-out <run>`,
    ])
  })

  test('grouped reviews include the total open findings', () => {
    const reviews = [
      {
        ...owed(),
        kind: 'untriaged-review',
        noun: 'untriaged review',
        qualifier: null,
        id: '7',
        command: `${PLATFORM_SLUG} review show <review>`,
        openFindings: 2,
      },
      {
        ...owed(),
        kind: 'untriaged-review',
        noun: 'untriaged review',
        qualifier: null,
        id: '8',
        command: `${PLATFORM_SLUG} review show <review>`,
        openFindings: 3,
      },
    ]
    expect(decideStopSummary(facts({ owedItems: reviews })).lines.at(-1)).toBe(
      `2 untriaged reviews (5 findings open): 7, 8 → ${PLATFORM_SLUG} review show <review>`,
    )
  })

  test('block identity ignores wording but changes when an id is added', () => {
    const first = decideStopSummary(facts({ owedItems: [owed()] }))
    const reworded = decideStopSummary(
      facts({
        owedItems: [
          {
            ...owed(),
            noun: 'rewritten run wording',
            qualifier: 'different words',
            command: 'different command',
          },
        ],
        previousBlockKey: first.blockKey,
      }),
    )
    expect(reworded.blockKey).toBe(first.blockKey)
    expect(reworded.block).toBeFalse()

    const added = decideStopSummary(
      facts({
        owedItems: [owed(), { ...owed(), id: '13' }],
        previousBlockKey: first.blockKey,
      }),
    )
    expect(added.blockKey).not.toBe(first.blockKey)
    expect(added.block).toBeTrue()
  })
})
