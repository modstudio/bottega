// concern: continuation-message
/** Binds the operator's continuation text to the exact prompt handed to a coordinator. */

import { createHash } from 'node:crypto'

export type ContinuationMessageBinding = {
  sha256: string
  bytes: number
}

export function continuationMessageBinding(message: string): ContinuationMessageBinding {
  return {
    sha256: createHash('sha256').update(message).digest('hex'),
    bytes: Buffer.byteLength(message),
  }
}

export function optionalContinuationMessageBinding(
  message: string | undefined,
): ContinuationMessageBinding | undefined {
  return message === undefined ? undefined : continuationMessageBinding(message)
}

function continuationPromptCarriesMessage(
  prompt: string,
  binding: ContinuationMessageBinding,
): boolean {
  const promptBytes = Buffer.from(prompt)
  if (binding.bytes > promptBytes.length) return false
  const messageBytes = promptBytes.subarray(promptBytes.length - binding.bytes)
  return createHash('sha256').update(messageBytes).digest('hex') === binding.sha256
}

function assertContinuationPromptCarriesMessage(
  prompt: string,
  binding: ContinuationMessageBinding | undefined,
): void {
  if (!binding || continuationPromptCarriesMessage(prompt, binding)) return
  throw new Error(
    'continuation prompt does not contain the recorded continuation message verbatim; refusing before launch',
  )
}

export function assertContinuationPromptCarriesPersistedMessage(
  prompt: string,
  persistedSha256: string | null,
  binding: ContinuationMessageBinding | undefined,
): void {
  if (persistedSha256 === null && binding === undefined) return
  if (persistedSha256 !== binding?.sha256) {
    throw new Error(
      'continuation message binding does not match the hash persisted on the turn; refusing before launch',
    )
  }
  assertContinuationPromptCarriesMessage(prompt, binding)
}
