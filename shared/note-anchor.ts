// concern: note-anchor-wire
/** Shared wire contract for note anchors produced by orchestrator and consumed by hub. */
import { z } from 'zod'

export const noteAnchorWireSchema = z.object({
  id: z.string().uuid().optional(),
  cwd: z.string(),
  project: z.string(),
  files: z.array(
    z.object({
      path: z.string(),
      line: z.number(),
      content: z.string(),
    }),
  ),
  run_record_id: z.string().uuid().nullable(),
  branch: z.string().nullable(),
  commit: z.string().nullable(),
  session_id: z.string().nullable(),
})

export type NoteAnchorWire = z.input<typeof noteAnchorWireSchema>
