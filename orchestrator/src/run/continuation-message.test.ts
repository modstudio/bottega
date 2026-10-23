import { describe, expect, test } from 'bun:test'
import {
  assertContinuationPromptCarriesPersistedMessage,
  continuationMessageBinding,
} from './continuation-message.ts'

describe('continuation message prompt binding', () => {
  test('coordinator guard refuses a prompt whose continuation message was replaced', () => {
    const binding = continuationMessageBinding('the architect correction')
    expect(() =>
      assertContinuationPromptCarriesPersistedMessage(
        'CHECKPOINT RESUME\n\nORIGINAL TASK SPEC',
        binding.sha256,
        binding,
      ),
    ).toThrow('does not contain the recorded continuation message verbatim')
  })

  test('coordinator guard trusts the persisted hash over the launch spec', () => {
    const binding = continuationMessageBinding('the wrong message')
    expect(() =>
      assertContinuationPromptCarriesPersistedMessage(
        'prompt ending in the wrong message',
        continuationMessageBinding('the recorded message').sha256,
        binding,
      ),
    ).toThrow('does not match the hash persisted on the turn')
  })
})
