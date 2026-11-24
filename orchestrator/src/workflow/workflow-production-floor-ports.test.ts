import { expect, spyOn, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import * as hubNotes from '../mcp/hub-notes.ts'
import { gatherNoteArtifactEvidence } from './workflow-floor-note-evidence.ts'
import { productionWorkflowFloorPorts } from './workflow-production-floor-ports.ts'

test('note evidence accepts a note sighted after step activation', async () => {
  const recordId = newRecordId()
  const list = spyOn(hubNotes, 'listHubNotes').mockResolvedValue([
    {
      record_id: recordId,
      label: 'fixture#1',
      text: 'fixture note',
      stale_at: null,
      stale_reason: null,
      promoted_task: null,
      created_at: '2026-08-01T00:00:00.000Z',
      last_seen_at: '2026-09-02T00:00:00.000Z',
    },
  ])

  try {
    await expect(
      gatherNoteArtifactEvidence(
        { kind: 'note', reference: recordId },
        `note:${recordId}`,
        'fixture',
        '2026-09-01T00:00:00.000Z',
        productionWorkflowFloorPorts(),
      ),
    ).resolves.toMatchObject({
      note: { recordId, writtenAt: '2026-09-02T00:00:00.000Z' },
    })
  } finally {
    list.mockRestore()
  }
})

test('note evidence refuses an old note with the sighting command', async () => {
  const recordId = newRecordId()
  const list = spyOn(hubNotes, 'listHubNotes').mockResolvedValue([
    {
      record_id: recordId,
      label: 'fixture#1',
      text: 'fixture note',
      stale_at: null,
      stale_reason: null,
      promoted_task: null,
      created_at: '2026-08-01T00:00:00.000Z',
      last_seen_at: '2026-08-02T00:00:00.000Z',
    },
  ])

  try {
    await expect(
      gatherNoteArtifactEvidence(
        { kind: 'note', reference: recordId },
        `note:${recordId}`,
        'fixture',
        '2026-09-01T00:00:00.000Z',
        productionWorkflowFloorPorts(),
      ),
    ).rejects.toThrow(`${PLATFORM_SLUG} note new --same-as fixture#1 --project fixture "<sighting>"`)
  } finally {
    list.mockRestore()
  }
})
