// concern: record-row-target
/** Owns HTTP parsing for a board-message or note row target. */

import { z } from 'zod'
import { type NoteLabel, parseNoteLabel } from '../../../shared/note-label.ts'

export type RecordRowTarget =
  | { message: string; note?: never }
  | { note: NoteLabel; message?: never }

export type ParsedRecordRowTarget =
  | { target: RecordRowTarget; body: Record<string, unknown> }
  | { error: string }

export function parseRecordRowTarget(value: unknown): ParsedRecordRowTarget {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return { error: 'body must be a JSON object' }
  const body = value as Record<string, unknown>
  const hasMessage = body.message !== undefined
  const hasNote = body.note !== undefined
  if (hasMessage === hasNote) return { error: 'exactly one of message or note is required' }
  if (hasMessage) {
    if (!z.string().uuid().safeParse(body.message).success)
      return { error: 'message must be a board message id' }
    return { target: { message: String(body.message) }, body }
  }
  if (typeof body.note !== 'string')
    return { error: `invalid note label '${String(body.note)}': expected project#number` }
  try {
    return { target: { note: parseNoteLabel(body.note) }, body }
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : `invalid note label '${String(body.note)}': expected project#number`,
    }
  }
}
