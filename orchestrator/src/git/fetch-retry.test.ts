import { describe, expect, test } from 'bun:test'
import {
  decideGitFetchRetry,
  GIT_FETCH_MAX_ATTEMPTS,
  GIT_FETCH_RETRY_BASE_DELAY_MS,
  isGitFetchInvocation,
} from './fetch-retry.ts'

test.each([
  ['git prefix', ['git', 'fetch', 'origin', 'main']],
  ['bare git arguments', ['fetch', 'origin', 'main']],
  ['flags before the remote', ['fetch', '--no-tags', '--', 'origin', 'main']],
] as const)('classifies a fetch of origin with %s', (_name, argv) => {
  expect(isGitFetchInvocation([...argv])).toBe(true)
})

test.each([
  ['another subcommand', ['git', 'checkout', 'fetch']],
  ['another remote', ['fetch', '--no-tags', '--', 'upstream', 'main']],
] as const)('does not classify %s', (_name, argv) => {
  expect(isGitFetchInvocation([...argv])).toBe(false)
})

describe('decideGitFetchRetry', () => {
  test.each([
    [1, GIT_FETCH_RETRY_BASE_DELAY_MS],
    [2, GIT_FETCH_RETRY_BASE_DELAY_MS * 2],
  ])('retries a ref-lock race after attempt %i', (attempt, delayMs) => {
    expect(
      decideGitFetchRetry(
        attempt,
        "error: cannot lock ref 'refs/remotes/origin/main': is at aaa but expected bbb",
      ),
    ).toEqual({ retry: true, delayMs })
  })

  test('stops after the named attempt limit', () => {
    expect(decideGitFetchRetry(GIT_FETCH_MAX_ATTEMPTS, 'cannot lock ref')).toEqual({
      retry: false,
    })
  })

  test('does not retry another git failure', () => {
    expect(decideGitFetchRetry(1, 'fatal: could not read from remote repository')).toEqual({
      retry: false,
    })
  })
})
