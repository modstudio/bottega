// concern: refusal-error
import { type Refusal, renderRefusal } from '../../shared/refusal.ts'

/** A deliberate refusal whose message tells the user how to proceed. */
export class RefusalError extends Error {
  readonly refusalDetail: Refusal

  constructor(refusalDetail: Refusal) {
    super(renderRefusal(refusalDetail))
    this.refusalDetail = refusalDetail
  }
}
