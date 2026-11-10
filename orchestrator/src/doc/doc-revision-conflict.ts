// concern: doc-revision-conflict
/** Owns the typed optimistic-write conflict and its record API wire contract. */
import { z } from 'zod'

export const REVISION_CONFLICT_CODE = 'revision-conflict' as const
export const DOC_REVISION_REFUSAL_REASONS = [
  'missing-hosted-revision',
  'stale-revision',
  'already-exists',
] as const
export type DocRevisionRefusalReason = (typeof DOC_REVISION_REFUSAL_REASONS)[number]
export type RevisionConflictReason = DocRevisionRefusalReason | 'workflow-version'

export const revisionConflictBodySchema = z.object({
  error: z.string().min(1),
  code: z.literal(REVISION_CONFLICT_CODE),
  reason: z.enum([...DOC_REVISION_REFUSAL_REASONS, 'workflow-version']),
  condition: z.string().min(1),
  currentRevision: z.string().nullable(),
})

export type RevisionConflictBody = z.infer<typeof revisionConflictBodySchema>

export class DocRevisionConflictError extends Error {
  readonly status = 409

  constructor(
    message: string,
    readonly condition: string,
    readonly reason: RevisionConflictReason,
    readonly currentRevision: string | null,
  ) {
    super(message)
  }
}

export function revisionConflictBody(error: DocRevisionConflictError): RevisionConflictBody {
  return {
    error: error.message,
    code: REVISION_CONFLICT_CODE,
    reason: error.reason,
    condition: error.condition,
    currentRevision: error.currentRevision,
  }
}
