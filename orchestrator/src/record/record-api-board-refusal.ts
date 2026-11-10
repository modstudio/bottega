// concern: record-api-board-refusal
/** Renders the board-specific refusal when no personal destination can be bound. */

import type { Context } from 'hono'
import { RECORD_PERSONAL_SPACE_REMEDY } from '../../../shared/record-remedies.ts'

export function boardNoSpace(context: Context): Response {
  return context.json(
    { error: 'record session has no personal space', remedy: RECORD_PERSONAL_SPACE_REMEDY },
    409,
  )
}
