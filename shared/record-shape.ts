// concern: record-shape
/** Pure shape policy for short records that carry working context. */

const RECORD_LIMITS = {
  STEP_NOTE_MAX_CHARS: 300,
  OPEN_QUESTION_MAX_CHARS: 800,
  RULING_MAX_CHARS: 1500,
  SELF_RULING_MAX_CHARS: 800,
  BASIS_MAX_CHARS: 800,
  NEXT_ACTION_MAX_CHARS: 400,
} as const

type RecordLimitName = keyof typeof RECORD_LIMITS

export const RECORD_SHAPES = {
  'step note': {
    maxChars: RECORD_LIMITS.STEP_NOTE_MAX_CHARS,
    constant: 'STEP_NOTE_MAX_CHARS' as RecordLimitName,
    lineRule: 'line',
  },
  'open question': {
    maxChars: RECORD_LIMITS.OPEN_QUESTION_MAX_CHARS,
    constant: 'OPEN_QUESTION_MAX_CHARS' as RecordLimitName,
    lineRule: 'paragraph',
  },
  ruling: {
    maxChars: RECORD_LIMITS.RULING_MAX_CHARS,
    constant: 'RULING_MAX_CHARS' as RecordLimitName,
    lineRule: 'paragraph',
  },
  'self-ruling': {
    maxChars: RECORD_LIMITS.SELF_RULING_MAX_CHARS,
    constant: 'SELF_RULING_MAX_CHARS' as RecordLimitName,
    lineRule: 'paragraph',
  },
  basis: {
    maxChars: RECORD_LIMITS.BASIS_MAX_CHARS,
    constant: 'BASIS_MAX_CHARS' as RecordLimitName,
    lineRule: 'paragraph',
  },
  'next action': {
    maxChars: RECORD_LIMITS.NEXT_ACTION_MAX_CHARS,
    constant: 'NEXT_ACTION_MAX_CHARS' as RecordLimitName,
    lineRule: 'line',
  },
} as const

export const OPEN_QUESTION_MAX_CHARS = RECORD_LIMITS.OPEN_QUESTION_MAX_CHARS
export const RULING_MAX_CHARS = RECORD_LIMITS.RULING_MAX_CHARS
export const NEXT_ACTION_MAX_CHARS = RECORD_LIMITS.NEXT_ACTION_MAX_CHARS

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
export function assertRecordShape(record: ContextRecordName, text: string): string {
  const refusal = recordShapeRefusal(record, text)
  if (refusal) throw new Error(refusal)
  return text
}
