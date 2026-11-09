// concern: record-revision-conflict
/** Owns the shared server/client wire shape for optimistic hosted-write conflicts. */
import { z } from 'zod'

export const REVISION_CONFLICT_CODE = 'revision-conflict' as const

export const revisionConflictBodySchema = z.object({
  error: z.string().min(1),
  code: z.literal(REVISION_CONFLICT_CODE),
  currentRevision: z.string(),
})

export type RevisionConflictBody = z.infer<typeof revisionConflictBodySchema>

export function revisionConflictBody(currentRevision: string): RevisionConflictBody {
  return {
    error: `hosted revision conflict; current revision is ${currentRevision}; re-read, then retry`,
    code: REVISION_CONFLICT_CODE,
    currentRevision,
  }
}

export class RecordRevisionConflictError extends Error {
  readonly status = 409
  readonly currentRevision: string

  constructor(currentRevision: string) {
    const body = revisionConflictBody(currentRevision)
    super(body.error)
    this.currentRevision = currentRevision
  }
}
