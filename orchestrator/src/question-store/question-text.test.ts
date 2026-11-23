import { expect, test } from 'bun:test'
import {
  MALFORMED_REQUIRED_TEXT_PREFIX,
  questionTextRefusal,
  requiredTextReachingHandler,
} from './question-text.ts'

test.each([
  ['object', {}, 'question was an object'],
  ['array', [], 'question was an array'],
  ['number', 7, 'question was a number'],
  ['empty', '', 'question was empty'],
  ['whitespace', '  \n', 'question was empty'],
  ['invisible-only', '\u200B', 'question was empty'],
  ['object coercion text', '[object Object]', 'question was the text [object Object]'],
  ['malformed sentinel', `${MALFORMED_REQUIRED_TEXT_PREFIX}number`, 'question was a number'],
] as const)('refuses %s text and names its shape', (_name, value, expected) => {
  const refusal = questionTextRefusal(value)
  expect(refusal?.message).toContain(expected)
  expect(refusal?.message).toContain('`question` must be the question text as a string')
})

test('accepts a string with content without changing it at the wire edge', () => {
  const question = '  Which path?  '
  expect(requiredTextReachingHandler(question)).toBe(question)
  expect(questionTextRefusal(question)).toBeNull()
})

test('accepts a question that starts with object coercion text but is not exactly that text', () => {
  expect(
    questionTextRefusal('[object Object] appears in the log; which coercion produced it?'),
  ).toBeNull()
})

test('field remedies name the note and message without repeating text', () => {
  expect(questionTextRefusal({}, 'text')?.message).toContain(
    '`text` must be the note as a single-line string.',
  )
  expect(questionTextRefusal({}, 'body')?.message).toContain(
    '`body` must be the message as a string.',
  )
  expect(questionTextRefusal({}, 'text')?.message).not.toContain('text text')
})
