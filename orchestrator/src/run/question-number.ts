// concern: run-identity
/** Owns the monotonic human-facing question number sequence. */

import type { Database } from 'bun:sqlite'
import { nextEntityNumber } from '../database/entity-number.ts'

export function nextQuestionNumber(database: Database): number {
  return nextEntityNumber(database, 'question')
}
