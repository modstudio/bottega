import { expect, test } from 'bun:test'
import { replyFileFallbackError } from './run-live.ts'

test('a missing reply file leaves a visible final-message fallback notice', () => {
  const path = '/var/tmp/orch/runs/42/scratch/reply.json'
  expect(replyFileFallbackError(path, false, null)).toBe(
    `reply.json missing at ${path}; used final-message fallback`,
  )
  expect(replyFileFallbackError(path, true, null)).toBeNull()
})
