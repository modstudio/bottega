import { describe, expect, test } from 'bun:test'
import {
  CONTEXT_REVIEW_MAX_MS,
  CONTEXT_REVIEW_MIN_MS,
  CONTEXT_REVIEW_MIN_SAMPLES,
  type ContextReviewFacts,
  contextReviewInterval,
  decideContextReview,
} from './context-review-decision.ts'

const now = Date.parse('2026-11-16T12:00:00.000Z')

function facts(overrides: Partial<ContextReviewFacts> = {}): ContextReviewFacts {
  return {
    now,
    sessionStartedAt: now - CONTEXT_REVIEW_MAX_MS,
    lastReviewAt: null,
    lastBriefInjectionAt: null,
    compactionGaps: [],
    items: [],
    openCursors: [],
    carriedTaskHolders: [],
    doneTaskKeys: [],
    ...overrides,
  }
}

describe('context review timing', () => {
  test('is due at the interval, not due one millisecond earlier, and resets after compaction', () => {
    expect(decideContextReview(facts()).due).toBe(true)
    expect(
      decideContextReview(facts({ sessionStartedAt: now - CONTEXT_REVIEW_MAX_MS + 1 })).due,
    ).toBe(false)
    expect(
      decideContextReview(facts({ lastBriefInjectionAt: now - CONTEXT_REVIEW_MAX_MS + 1 })).due,
    ).toBe(false)
  })

  test('uses the maximum below the sample floor and clamps the median at both ends', () => {
    expect(
      contextReviewInterval(
        now,
        Array.from({ length: CONTEXT_REVIEW_MIN_SAMPLES - 1 }, () => ({ at: now, gapMs: 1 })),
      ),
    ).toBe(CONTEXT_REVIEW_MAX_MS)
    expect(
      contextReviewInterval(
        now,
        Array.from({ length: CONTEXT_REVIEW_MIN_SAMPLES }, () => ({ at: now, gapMs: 1 })),
      ),
    ).toBe(CONTEXT_REVIEW_MIN_MS)
    expect(
      contextReviewInterval(
        now,
        Array.from({ length: CONTEXT_REVIEW_MIN_SAMPLES }, () => ({
          at: now,
          gapMs: CONTEXT_REVIEW_MAX_MS * 2,
        })),
      ),
    ).toBe(CONTEXT_REVIEW_MAX_MS)
  })

  test('rounds a fractional median from an even number of in-window gaps', () => {
    const interval = contextReviewInterval(
      now,
      [600_000, 600_000, 600_000, 600_001, 600_001, 600_001].map((gapMs) => ({
        at: now,
        gapMs,
      })),
    )
    expect(interval).toBe(600_001)
    expect(Number.isInteger(interval)).toBe(true)
  })
})

test('flags only stale facts and pointers and orders flagged items first', () => {
  const old = now - 10_000
  const items = [
    {
      recordId: 'record-new',
      id: 'new',
      kind: 'fact' as const,
      holder: 'task:open',
      updatedAt: now,
      body: 'current',
    },
    {
      id: 'ruling',
      recordId: 'record-ruling',
      kind: 'ruling' as const,
      holder: 'task:closed',
      updatedAt: old,
      body: 'DEV-1 is done',
    },
    {
      id: 'old',
      recordId: 'record-old',
      kind: 'fact' as const,
      holder: 'task:open',
      updatedAt: old,
      body: 'old step',
    },
    {
      id: 'done',
      recordId: 'record-done',
      kind: 'pointer' as const,
      holder: 'session:s',
      updatedAt: now,
      body: 'see DEV-1',
    },
    {
      id: 'closed',
      recordId: 'record-closed',
      kind: 'fact' as const,
      holder: 'task:closed',
      updatedAt: now,
      body: 'holder stale',
    },
    {
      id: 'position',
      recordId: 'record-position',
      kind: 'position' as const,
      holder: 'task:closed',
      updatedAt: old,
      body: 'DEV-1 is done',
    },
  ]
  const decision = decideContextReview(
    facts({
      items,
      openCursors: [{ holder: 'task:open', stepStartedAt: now - 1_000 }],
      carriedTaskHolders: ['task:open'],
      doneTaskKeys: ['DEV-1'],
    }),
  )
  expect(decision.items.map(({ id }) => id)).toEqual([
    'old',
    'done',
    'closed',
    'new',
    'ruling',
    'position',
  ])
  expect(decision.items.find(({ id }) => id === 'old')?.reason).toBe('older than the current step')
  expect(decision.items.find(({ id }) => id === 'done')?.reason).toBe('names done task DEV-1')
  expect(decision.items.find(({ id }) => id === 'closed')?.reason).toBe('holder has no open cursor')
  expect(
    decision.items
      .filter(({ id }) => id === 'ruling' || id === 'position')
      .map(({ id, flagged, reason }) => [id, flagged, reason]),
  ).toEqual([
    ['ruling', false, null],
    ['position', false, null],
  ])
})

test('flags an item that names a done slice task', () => {
  const decision = decideContextReview(
    facts({
      items: [
        {
          recordId: 'record-slice',
          id: 'slice',
          kind: 'fact',
          holder: 'session:one',
          updatedAt: now,
          body: 'DEV-1844/2 is already complete',
        },
      ],
      doneTaskKeys: ['DEV-1844/2'],
    }),
  )

  expect(decision.items[0]).toEqual(
    expect.objectContaining({ flagged: true, reason: 'names done task DEV-1844/2' }),
  )
})

test('an epic carried through a child cursor is not stale or older than the child step', () => {
  const epicHolder = 'task:epic'
  const decision = decideContextReview({
    ...facts({
      items: [
        {
          recordId: 'record-epic',
          id: 'epic-fact',
          kind: 'fact',
          holder: epicHolder,
          updatedAt: now - 10_000,
          body: 'still current',
        },
      ],
      openCursors: [{ holder: 'task:child', stepStartedAt: now - 1_000 }],
    }),
    carriedTaskHolders: [epicHolder, 'task:child'],
  })

  expect(decision.items[0]).toEqual(expect.objectContaining({ flagged: false, reason: null }))
})
