import { describe, expect, test } from 'bun:test'
import {
  decideGitFetchRetry,
  GIT_FETCH_MAX_ATTEMPTS,
  GIT_FETCH_RETRY_BASE_DELAY_MS,
} from './fetch-retry.ts'

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
