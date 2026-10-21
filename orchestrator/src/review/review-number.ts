// concern: review-identity
/** Owns the monotonic human-facing review number sequence. */

import type { Database } from 'bun:sqlite'
import { nextEntityNumber } from '../database/entity-number.ts'

export function nextReviewNumber(database: Database): number {
  return nextEntityNumber(database, 'review')
}
