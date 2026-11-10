// concern: record-revision-conflict
/** Owns the shared server/client wire shape for optimistic hosted-write conflicts. */
import { z } from 'zod'

const REVISION_CONFLICT_CODE = 'revision-conflict' as const

export const revisionConflictBodySchema = z.object({
  error: z.string().min(1),
  code: z.literal(REVISION_CONFLICT_CODE),
  currentRevision: z.string().nullable(),
})

export type RevisionConflictBody = z.infer<typeof revisionConflictBodySchema>

export function revisionConflictBody(
  error: string,
  currentRevision: string | null,
): RevisionConflictBody {
  return {
    error,
    code: REVISION_CONFLICT_CODE,
    currentRevision,
  }
}

export class RecordRevisionConflictError extends Error {
  readonly status = 409
  readonly currentRevision: string | null

  constructor(message: string, currentRevision: string | null) {
    super(message)
    this.currentRevision = currentRevision
  }
}
