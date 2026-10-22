import { describe, expect, test } from 'bun:test'
import {
  assertContinuationPromptCarriesMessage,
  continuationMessageBinding,
  continuationPromptCarriesMessage,
} from './continuation-message.ts'
import { renderCheckpointContinuationPrompt } from './run-retry.ts'

describe('continuation message prompt binding', () => {
  test('checkpoint resume carries the continuation message verbatim', () => {
    const message = 'Apply all seven review fixes.\nKeep `--file` literal.\n'
    const prompt = renderCheckpointContinuationPrompt({
      checkpointContext: 'CHECKPOINT RESUME\nResume at dc998b9f2.',
      originalSpec: 'ORIGINAL TASK SPEC',
      continuationInstructions: [],
      message,
    })

    expect(prompt.endsWith(message)).toBe(true)
    expect(continuationPromptCarriesMessage(prompt, continuationMessageBinding(message))).toBe(true)
  })

  test('coordinator guard refuses a prompt whose continuation message was replaced', () => {
    const binding = continuationMessageBinding('the architect correction')
    expect(() =>
      assertContinuationPromptCarriesMessage('CHECKPOINT RESUME\n\nORIGINAL TASK SPEC', binding),
    ).toThrow('does not contain the recorded continuation message verbatim')
  })
})
