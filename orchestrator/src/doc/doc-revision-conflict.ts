// concern: doc-revision-conflict
/** Owns the typed optimistic-write conflict and its record API wire contract. */
import { z } from 'zod'
import type { DocRevisionRefusalReason } from './doc-write-allowed.ts'

export const REVISION_CONFLICT_CODE = 'revision-conflict' as const
const DOC_REVISION_REFUSAL_REASONS = [
  'missing-hosted-revision',
  'stale-revision',
  'already-exists',
] as const
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
  readonly condition: string
  readonly reason: RevisionConflictReason
  readonly currentRevision: string | null

  constructor(
    message: string,
    condition: string,
    reason: RevisionConflictReason,
    currentRevision: string | null,
  ) {
    super(message)
    this.condition = condition
    this.reason = reason
    this.currentRevision = currentRevision
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
