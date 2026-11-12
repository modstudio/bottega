// concern: record-api-board-refusal
/** Renders the board-specific refusal selected by the tenant seam. */

import type { Context } from 'hono'
import {
  RECORD_PERSONAL_SPACE_REMEDY,
  recordWriteSpaceRefusal,
  type WriteSpaceRefusal,
} from '../../../shared/record-remedies.ts'

export function boardNoSpace(context: Context, refusal?: WriteSpaceRefusal | null): Response {
  if (refusal?.refused === 'write-destination') {
    const rendered = recordWriteSpaceRefusal()
    return context.json(rendered.body, rendered.status)
  }
  return context.json(
    { error: 'record session has no personal space', remedy: RECORD_PERSONAL_SPACE_REMEDY },
    409,
  )
}
