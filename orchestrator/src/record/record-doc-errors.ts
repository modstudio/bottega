// concern: record-doc-errors
/** Turns pure document-write decisions into hosted-service errors. */
import { decideDocRevisionWrite } from '../doc/doc-write-allowed.ts'

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

export function assertRevisionWrite(input: {
  expectedRevision?: string
  current: unknown
  isCreate: boolean
  scope: string
}): void {
  const decision = decideDocRevisionWrite({
    expected: input.expectedRevision,
    current: input.current == null ? null : String(input.current),
    isCreate: input.isCreate,
    scope: input.scope,
  })
  if (!decision.allow) throw new RecordDocError(decision.reason, 409)
}
