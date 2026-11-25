// concern: workflow-floor-adapter
/** Assembles production floor ports at the CLI and MCP composition surfaces. */

import { findHubNote, type HubNoteOutput, listHubNotesPromotedTo } from '../mcp/hub-notes.ts'
import { type FloorEvidencePorts, productionFloorPorts } from './workflow-floor-evidence.ts'
import { productionReviewOwedFloor } from './workflow-review-owed-floor.ts'

export const productionWorkflowFloorPorts = (output?: HubNoteOutput): FloorEvidencePorts => ({
  ...productionFloorPorts(),
  readNote: async (project, reference) => {
    const note = await findHubNote(project, reference, { cwd: process.cwd(), output })
    return note
      ? {
          recordId: note.record_id,
          label: note.label,
          promotedTask: note.promoted_task,
          staleAt: note.stale_at,
          writtenAt:
            Date.parse(note.last_seen_at) > Date.parse(note.created_at)
              ? note.last_seen_at
              : note.created_at,
        }
      : null
  },
  listPromotedNotes: async (project, taskKey) => {
    const notes = await listHubNotesPromotedTo(project, taskKey, {
      cwd: process.cwd(),
      output,
    })
    return notes
      .filter((note) => note.promoted_task === taskKey)
      .map((note) => ({
        recordId: note.record_id,
        label: note.label,
        staleAt: note.stale_at,
      }))
  },
  reviewOwed: productionReviewOwedFloor,
})
