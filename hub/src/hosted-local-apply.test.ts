import { expect, spyOn, test } from 'bun:test'
import { applyHostedWriteLocally } from './hosted-local-apply.ts'

test('a lock refusal returns false and prints the caller message', () => {
  const messages: string[] = []
  const error = spyOn(console, 'error').mockImplementation((message) =>
    messages.push(String(message)),
  )
  try {
    expect(
      applyHostedWriteLocally('the hosted write succeeded; pull its local copy later', () => {
        throw new Error('database is locked')
      }),
    ).toBeFalse()
    expect(messages).toEqual(['the hosted write succeeded; pull its local copy later'])
  } finally {
    error.mockRestore()
  }
})

test('a non-lock local apply error is rethrown and prints nothing', () => {
  const messages: string[] = []
  const error = spyOn(console, 'error').mockImplementation((message) =>
    messages.push(String(message)),
  )
  const failure = new Error('constraint failed')
  try {
    expect(() =>
      applyHostedWriteLocally('this message must not print', () => {
        throw failure
      }),
    ).toThrow(failure)
    expect(messages).toEqual([])
  } finally {
    error.mockRestore()
  }
})
