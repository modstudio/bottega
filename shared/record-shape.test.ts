import { describe, expect, test } from 'bun:test'
import type { ContextRecordName, RECORD_SHAPES } from './record-shape.ts'
import { recordShapeRefusal } from './record-shape.ts'

describe('context-bearing record shapes', () => {
  const declared = {
    'step note': { maxChars: 300, constant: 'STEP_NOTE_MAX_CHARS', lineRule: 'line' },
    'open question': { maxChars: 800, constant: 'OPEN_QUESTION_MAX_CHARS', lineRule: 'paragraph' },
    ruling: { maxChars: 1500, constant: 'RULING_MAX_CHARS', lineRule: 'paragraph' },
    'self-ruling': { maxChars: 800, constant: 'SELF_RULING_MAX_CHARS', lineRule: 'paragraph' },
    basis: { maxChars: 800, constant: 'BASIS_MAX_CHARS', lineRule: 'paragraph' },
  } as const satisfies Record<ContextRecordName, (typeof RECORD_SHAPES)[ContextRecordName]>

  for (const [record, shape] of Object.entries(declared) as [
    ContextRecordName,
    (typeof declared)[ContextRecordName],
  ][]) {
    test(`${record} enforces its character boundary`, () => {
      expect(recordShapeRefusal(record, 'x'.repeat(shape.maxChars))).toBeNull()
      expect(recordShapeRefusal(record, 'x'.repeat(shape.maxChars + 1))).toBe(
        `${record} is ${shape.maxChars + 1} characters; the limit is ${shape.maxChars} (${shape.constant}). Shorten it and put detail in a task document.`,
      )
    })

    test(`${record} refuses empty text`, () => {
      expect(recordShapeRefusal(record, ' \t ')).toBe(
        `${record} must not be empty. Write the record and put detail in a task document.`,
      )
    })

    test(`${record} enforces its line rule`, () => {
      const invalid = shape.lineRule === 'line' ? 'first\nsecond' : 'first\n \t\nsecond'
      const rule = shape.lineRule === 'line' ? 'one line' : 'one paragraph with no blank line'
      expect(recordShapeRefusal(record, invalid)).toBe(
        `${record} must be ${rule}. Shorten it and put detail in a task document.`,
      )
    })
  }

  test('paragraph records allow a single newline', () => {
    for (const record of ['open question', 'ruling', 'self-ruling', 'basis'] as const) {
      expect(recordShapeRefusal(record, 'first\nsecond')).toBeNull()
    }
  })
})
