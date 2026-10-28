import { describe, expect, test } from 'bun:test'
import {
  evaluateNoteStaleness,
  type NoteStalenessFacts,
  type StalenessAnchorObservation,
} from './note-staleness.ts'

const anchor = (
  overrides: Partial<StalenessAnchorObservation> = {},
): StalenessAnchorObservation => ({
  sessionId: 'reporter',
  projectFound: true,
  files: [],
  run: null,
  branch: null,
  ...overrides,
})

const facts = (overrides: Partial<NoteStalenessFacts> = {}): NoteStalenessFacts => ({
  note: {
    anchors: [anchor()],
    promotedTask: null,
    staleAt: null,
    staleReason: null,
  },
  acknowledgementSessions: [],
  ...overrides,
})

describe('note staleness', () => {
  test('uses the observed cross-project branch state', () => {
    const result = evaluateNoteStaleness(
      facts({
        note: {
          anchors: [
            anchor({
              branch: { name: 'topic', trunk: 'master', exists: true, landed: false },
            }),
          ],
          promotedTask: null,
          staleAt: null,
          staleReason: null,
        },
      }),
    )
    expect(result).toEqual({ action: 'unchanged', reason: null, triaged: false })
  })

  test('does not use trunk distance to vanish a commit anchor', () => {
    const result = evaluateNoteStaleness(facts())
    expect(result).toEqual({ action: 'unchanged', reason: null, triaged: false })
  })

  test('uses observed shifted file text and existence-only empty text', () => {
    const shifted = evaluateNoteStaleness(
      facts({
        note: {
          anchors: [
            anchor({
              files: [
                {
                  path: 'src/subject.ts',
                  line: 2,
                  exists: true,
                  containsAnchoredContent: true,
                },
              ],
            }),
          ],
          promotedTask: null,
          staleAt: null,
          staleReason: null,
        },
      }),
    )
    expect(shifted).toEqual({ action: 'unchanged', reason: null, triaged: false })
  })

  test('vanishes observed removed line text', () => {
    const removed = evaluateNoteStaleness(
      facts({
        note: {
          anchors: [
            anchor({
              files: [
                {
                  path: 'subject.ts',
                  line: 7,
                  exists: true,
                  containsAnchoredContent: false,
                },
              ],
            }),
          ],
          promotedTask: null,
          staleAt: null,
          staleReason: null,
        },
      }),
    )
    expect(removed).toEqual({
      action: 'annotate',
      reason: 'subject.ts:7 no longer has its anchored content',
      triaged: false,
    })
  })

  test('a reporter keep is not triage while another session keep is', () => {
    const gone = anchor({
      branch: { name: 'gone', trunk: 'main', exists: false, landed: false },
    })
    const note = {
      anchors: [gone],
      promotedTask: null,
      staleAt: null,
      staleReason: null,
    }
    expect(evaluateNoteStaleness(facts({ note, acknowledgementSessions: ['reporter'] }))).toEqual({
      action: 'annotate',
      reason: 'branch gone was deleted',
      triaged: false,
    })
    expect(evaluateNoteStaleness(facts({ note, acknowledgementSessions: ['reviewer'] }))).toEqual({
      action: 'mark',
      reason: 'branch gone was deleted',
      triaged: true,
    })
  })

  test('restores stale untriaged notes and clears obsolete live annotations', () => {
    const stale = evaluateNoteStaleness(
      facts({
        note: {
          anchors: [
            anchor({
              branch: { name: 'gone', trunk: 'main', exists: false, landed: false },
            }),
          ],
          promotedTask: null,
          staleAt: '2026-10-01T00:00:00.000Z',
          staleReason: 'old reason',
        },
      }),
    )
    const obsolete = evaluateNoteStaleness(
      facts({
        note: {
          anchors: [anchor()],
          promotedTask: null,
          staleAt: null,
          staleReason: 'old annotation',
        },
      }),
    )
    expect(stale).toEqual({
      action: 'restore',
      reason: 'branch gone was deleted',
      triaged: false,
    })
    expect(obsolete).toEqual({ action: 'restore', reason: null, triaged: false })
  })

  test('does not rewrite an unchanged annotation', () => {
    const reason = 'branch gone was deleted'
    const result = evaluateNoteStaleness(
      facts({
        note: {
          anchors: [
            anchor({
              branch: { name: 'gone', trunk: 'main', exists: false, landed: false },
            }),
          ],
          promotedTask: null,
          staleAt: null,
          staleReason: reason,
        },
      }),
    )
    expect(result).toEqual({ action: 'unchanged', reason, triaged: false })
  })

  test('never restores a dropped note', () => {
    const result = evaluateNoteStaleness(
      facts({
        note: {
          anchors: [anchor()],
          promotedTask: null,
          staleAt: '2026-10-01T00:00:00.000Z',
          staleReason: 'dropped: resolved',
        },
      }),
    )
    expect(result).toEqual({
      action: 'unchanged',
      reason: 'dropped: resolved',
      triaged: true,
    })
  })
})
