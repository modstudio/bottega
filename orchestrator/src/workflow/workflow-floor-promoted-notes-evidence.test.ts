import { expect, test } from 'bun:test'
import { withReplayedFloorEvidenceAsync } from './workflow-floor-evidence-replay.ts'
import { gatherPromotedNotes } from './workflow-floor-promoted-notes-evidence.ts'

test('promoted notes are replayed once and returned as known evidence', async () => {
  let calls = 0
  const result = await withReplayedFloorEvidenceAsync(
    {
      listPromotedNotes: async () => {
        calls += 1
        return [{ recordId: 'note-1', label: 'fixture#1', staleAt: null }]
      },
    },
    async (ports) => gatherPromotedNotes('fixture', 'DEV-977', ports),
  )

  expect(result).toEqual({
    known: true,
    notes: [{ recordId: 'note-1', label: 'fixture#1', staleAt: null }],
  })
  expect(calls).toBe(1)
})

test('an unreadable promoted-note set keeps only the first error line', async () => {
  const result = await withReplayedFloorEvidenceAsync(
    {
      listPromotedNotes: async () => {
        throw new Error('hub unavailable\nrequest detail')
      },
    },
    async (ports) => gatherPromotedNotes('fixture', 'DEV-977', ports),
  )

  expect(result).toEqual({ known: false, reason: 'hub unavailable' })
  await expect(gatherPromotedNotes('fixture', 'DEV-977', {})).resolves.toEqual({
    known: false,
    reason: 'floor evidence port listPromotedNotes has no implementation',
  })
})
