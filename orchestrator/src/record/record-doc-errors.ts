// concern: record-doc-errors
/** Turns pure document-write decisions into hosted-service errors. */
import { renderRefusal } from '../../../shared/refusal.ts'
import {
  type DocRevisionOp,
  type DocRevisionWriteInput,
  decideDocRevisionWrite,
} from '../doc/doc-write-allowed.ts'
import { RecordRevisionConflictError } from './record-revision-conflict.ts'

export class RecordDocError extends Error {
  status: 400 | 404 | 409 | 422
  constructor(message: string, status: 400 | 404 | 409 | 422 = 400) {
    super(message)
    this.status = status
  }
}

export function assertWrite(refusal: string | null): void {
  if (refusal) throw new RecordDocError(refusal)
}

export function assertRevisionWrite(
  input: Omit<DocRevisionWriteInput, 'expected' | 'current' | 'op'> & {
    expectedRevision?: string
    current: unknown
    op?: DocRevisionOp
  },
): void {
  const decision = decideDocRevisionWrite({
    expected: input.expectedRevision,
    current: input.current == null ? null : String(input.current),
    isCreate: input.isCreate,
    op: input.op,
    scope: input.scope,
    subject: input.subject,
    slug: input.slug,
  })
  if (!decision.allow) {
    const message = renderRefusal(decision.refusal)
    if (decision.reason === 'missing-hosted-revision') throw new RecordDocError(message, 409)
    throw new RecordRevisionConflictError(
      message,
      input.current == null ? null : String(input.current),
    )
  }
}
