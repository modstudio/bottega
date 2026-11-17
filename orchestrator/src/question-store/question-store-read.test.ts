import { expect, test } from 'bun:test'
import { questionByNumber } from './question-store-read.ts'

test('a question number repeated across record spaces refuses instead of picking one', () => {
  const personal = { record_id: 'personal', number: 12 }
  const project = { record_id: 'project', number: 12 }
  const other = { record_id: 'other', number: 13 }
  expect(() => questionByNumber([personal, project, other], 12)).toThrow(
    'names 2 questions on this cursor in different record spaces',
  )
  expect(questionByNumber([personal, other], 12)).toBe(personal)
  expect(questionByNumber([other], 12)).toBeNull()
})
