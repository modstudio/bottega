// concern: run-identity
/** Owns the monotonic human-facing run number sequence. */

import type { Database } from 'bun:sqlite'
import { nextEntityNumber } from '../database/entity-number.ts'

/** Allocate a run number once. Deleting the eventual run row never returns it. */
export function nextRunNumber(database: Database): number {
  return nextEntityNumber(database, 'run')
}
