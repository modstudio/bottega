import { describe, expect, test } from 'bun:test'
import { UNJUDGED_OWNER_WINDOW_MS } from './cleanup-sweep-decisions.ts'
import { decideSessionCursorSweep } from './cleanup-sweep-explore-decision.ts'

const now = Date.parse('2026-11-12T12:00:00.000Z')

function facts(
  changes: Partial<Parameters<typeof decideSessionCursorSweep>[0]> = {},
): Parameters<typeof decideSessionCursorSweep>[0] {
  return {
    ownerSessionId: 'session',
    ownerLastSeenAt: now,
    runLastActivityAt: now - UNJUDGED_OWNER_WINDOW_MS - 1,
    now,
    windowMs: UNJUDGED_OWNER_WINDOW_MS,
    cursor: 7,
    workflowSlug: 'explore',
    stepSlug: 'investigate',
    openQuestionRecordId: null,
    ...changes,
  }
}

describe('session cursor sweep decision', () => {
  test('keeps an explore held by a live session', () => {
    expect(decideSessionCursorSweep(facts())).toEqual({ action: 'keep' })
  })

  test('keeps a gone explore within the owner window', () => {
    expect(
      decideSessionCursorSweep(facts({ ownerLastSeenAt: now - UNJUDGED_OWNER_WINDOW_MS + 1 })),
    ).toEqual({ action: 'keep' })
  })

  test('expires an idle explore past the owner window', () => {
    expect(
      decideSessionCursorSweep(facts({ ownerLastSeenAt: now - UNJUDGED_OWNER_WINDOW_MS - 1 })),
    ).toEqual({ action: 'expire' })
  })

  test('reports an open question past the owner window', () => {
    expect(
      decideSessionCursorSweep(
        facts({
          ownerLastSeenAt: now - UNJUDGED_OWNER_WINDOW_MS - 1,
          openQuestionRecordId: 'question-id',
        }),
      ),
    ).toEqual(
      expect.objectContaining({
        action: 'report',
        item: 'workflow question question-id on cursor 7',
        remedy: expect.stringContaining('workflow abandon explore --cursor 7'),
      }),
    )
  })

  test('reports a non-explore cursor past the owner window', () => {
    expect(
      decideSessionCursorSweep(
        facts({
          ownerLastSeenAt: now - UNJUDGED_OWNER_WINDOW_MS - 1,
          workflowSlug: 'operate',
        }),
      ),
    ).toEqual(
      expect.objectContaining({
        action: 'report',
        item: 'workflow cursor 7 (operate)',
        remedy: expect.stringContaining('workflow step operate investigate --cursor 7'),
      }),
    )
  })
})
