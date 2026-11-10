// concern: record-api-board-refusal
/** Renders the board-specific refusal when no personal destination can be bound. */

import type { Context } from 'hono'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'

const remedy = `run \`${PLATFORM_SLUG} record sign-in\` to restore the personal space`

export function boardNoSpace(context: Context): Response {
  return context.json({ error: 'record session has no personal space', remedy }, 409)
}
