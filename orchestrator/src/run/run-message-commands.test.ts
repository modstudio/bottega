import { expect, test } from 'bun:test'
import { continuationCommandMessage } from './run-message-commands.ts'

test('continue with findings composes the findings block with the architect message', () => {
  const message = 'Keep this architect message verbatim.'
  expect(
    continuationCommandMessage(42, message, true, (runId, text) =>
      [`findings for ${runId}`, text, 'answer each number'].join('\n'),
    ),
  ).toBe('findings for 42\nKeep this architect message verbatim.\nanswer each number')
})

test('continue without findings leaves the message exactly unchanged', () => {
  const message = 'Continue exactly as before.'
  expect(
    continuationCommandMessage(42, message, false, () => {
      throw new Error('renderer must not be called')
    }),
  ).toBe(message)
})
