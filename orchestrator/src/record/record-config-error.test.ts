import { expect, test } from 'bun:test'
import { isUniqueViolation } from './record-config-error.ts'

test('a unique violation is identified through a query error cause', () => {
  const unique = Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
    constraint: 'question_space_number_unique',
  })
  const wrapped = new Error('Failed query: insert into question', { cause: unique })
  const otherConstraint = new Error('Failed query: insert into question', {
    cause: Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
      constraint: 'another_unique_constraint',
    }),
  })

  expect(isUniqueViolation(wrapped, 'question_space_number_unique')).toBeTrue()
  expect(isUniqueViolation(otherConstraint, 'question_space_number_unique')).toBeFalse()
})
