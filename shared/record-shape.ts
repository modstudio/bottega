// concern: record-shape
/** Pure shape policy for short records that carry working context. */

export const RECORD_SHAPES = {
  'step note': {
    maxChars: 300,
    constant: 'STEP_NOTE_MAX_CHARS',
    lineRule: 'line',
  },
  'open question': {
    maxChars: 800,
    constant: 'OPEN_QUESTION_MAX_CHARS',
    lineRule: 'paragraph',
  },
  ruling: {
    maxChars: 1500,
    constant: 'RULING_MAX_CHARS',
    lineRule: 'paragraph',
  },
  'self-ruling': {
    maxChars: 800,
    constant: 'SELF_RULING_MAX_CHARS',
    lineRule: 'paragraph',
  },
  basis: {
    maxChars: 800,
    constant: 'BASIS_MAX_CHARS',
    lineRule: 'paragraph',
  },
  'next action': {
    maxChars: 400,
    constant: 'NEXT_ACTION_MAX_CHARS',
    lineRule: 'line',
  },
} as const

export const STEP_NOTE_MAX_CHARS = RECORD_SHAPES['step note'].maxChars
export const OPEN_QUESTION_MAX_CHARS = RECORD_SHAPES['open question'].maxChars
export const RULING_MAX_CHARS = RECORD_SHAPES.ruling.maxChars
export const SELF_RULING_MAX_CHARS = RECORD_SHAPES['self-ruling'].maxChars
export const BASIS_MAX_CHARS = RECORD_SHAPES.basis.maxChars
export const NEXT_ACTION_MAX_CHARS = RECORD_SHAPES['next action'].maxChars

export type ContextRecordName = keyof typeof RECORD_SHAPES

const REMEDY = 'Shorten it and put detail in a task document.'
const EMPTY_REMEDY = 'Write the record and put detail in a task document.'
const BLANK_LINE = /\r?\n[\t ]*\r?\n/

/** Return the refusal for one context-bearing record, or null when it has the declared shape. */
export function recordShapeRefusal(record: ContextRecordName, text: string): string | null {
  const shape = RECORD_SHAPES[record]
  if (!text.trim()) return `${record} must not be empty. ${EMPTY_REMEDY}`
  if (shape.lineRule === 'line' && /\r|\n/.test(text)) {
    return `${record} must be one line. ${REMEDY}`
  }
  if (shape.lineRule === 'paragraph' && BLANK_LINE.test(text)) {
    return `${record} must be one paragraph with no blank line. ${REMEDY}`
  }
  if (text.length > shape.maxChars) {
    return `${record} is ${text.length} characters; the limit is ${shape.maxChars} (${shape.constant}). ${REMEDY}`
  }
  return null
}

/** Refuse invalid record text at a writing edge. */
export function assertRecordShape(record: ContextRecordName, text: string): void {
  const refusal = recordShapeRefusal(record, text)
  if (refusal) throw new Error(refusal)
}
