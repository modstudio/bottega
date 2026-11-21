// concern: workflow-floor-adapter
/** Assembles production floor ports at the CLI and MCP composition surfaces. */

import { listHubNotes } from '../mcp/hub-notes.ts'
import { type FloorEvidencePorts, productionFloorPorts } from './workflow-floor-evidence.ts'
import { productionReviewOwedFloor } from './workflow-review-owed-floor.ts'

export const productionWorkflowFloorPorts = (): FloorEvidencePorts => ({
  ...productionFloorPorts(),
  readNote: async (project, reference) => {
    const notes = await listHubNotes(project, { cwd: process.cwd() })
    const normalized = reference.toLowerCase()
    const note = notes.find(
      (candidate) =>
        candidate.record_id.toLowerCase() === normalized ||
        candidate.label.toLowerCase() === normalized,
    )
    return note
      ? {
          recordId: note.record_id,
          label: note.label,
          promotedTask: note.promoted_task,
          staleAt: note.stale_at,
          writtenAt: note.last_seen_at,
        }
      : null
  },
  reviewOwed: productionReviewOwedFloor,
})
