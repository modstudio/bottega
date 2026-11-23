import { expect, spyOn, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import * as hubNotes from '../mcp/hub-notes.ts'
import { productionWorkflowFloorPorts } from './workflow-production-floor-ports.ts'

test('note evidence uses creation time rather than its latest sighting', async () => {
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
    await expect(productionWorkflowFloorPorts().readNote?.('fixture', recordId)).resolves.toEqual({
      recordId,
      label: 'fixture#1',
      promotedTask: null,
      staleAt: null,
      writtenAt: '2026-08-01T00:00:00.000Z',
    })
  } finally {
    list.mockRestore()
  }
})
