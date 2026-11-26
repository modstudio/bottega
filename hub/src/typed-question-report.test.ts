import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { typedQuestionLabelResolver } from './typed-question-report.ts'

test('only note_duplicate resolves pair outcome labels', () => {
  const database = null as unknown as Database
  expect(typedQuestionLabelResolver('note_duplicate', database)).toBeFunction()
  expect(typedQuestionLabelResolver('note_class', database)).toBeNull()
})
