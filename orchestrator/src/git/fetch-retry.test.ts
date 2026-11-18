import { describe, expect, test } from 'bun:test'
import {
  decideGitFetchRetry,
  GIT_FETCH_MAX_ATTEMPTS,
  GIT_FETCH_RETRY_BASE_DELAY_MS,
  isGitFetchInvocation,
  runWithGitFetchRetry,
} from './fetch-retry.ts'

test.each([
  ['git prefix', ['git', 'fetch', 'origin', 'main']],
  ['bare git arguments', ['fetch', 'origin', 'main']],
  ['flags before the remote', ['fetch', '--no-tags', '--', 'origin', 'main']],
  ['another remote', ['fetch', '--no-tags', '--', 'upstream', 'main']],
  ['a valued option', ['git', 'fetch', '--depth', '1', 'origin', 'main']],
] as const)('classifies a fetch with %s', (_name, argv) => {
  expect(isGitFetchInvocation([...argv])).toBe(true)
})

test('does not classify another subcommand', () => {
  expect(isGitFetchInvocation(['git', 'checkout', 'fetch'])).toBe(false)
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

describe('runWithGitFetchRetry', () => {
  test('returns a successful retry after a ref-lock race', () => {
    let attempts = 0
    const result = runWithGitFetchRetry(['git', 'fetch', 'origin', 'main'], () => {
      attempts += 1
      return attempts === 1
        ? {
            result: 'first failure',
            succeeded: false,
            stderr: "cannot lock ref 'refs/remotes/origin/main'",
          }
        : { result: 'second success', succeeded: true, stderr: '' }
    })

    expect(result).toBe('second success')
    expect(attempts).toBe(2)
  })

  test('returns the last failure after the attempt limit', () => {
    let attempts = 0
    const result = runWithGitFetchRetry(['fetch', 'origin', 'main'], () => {
      attempts += 1
      return {
        result: `failure ${attempts}`,
        succeeded: false,
        stderr: "cannot lock ref 'refs/remotes/origin/main'",
      }
    })

    expect(result).toBe(`failure ${GIT_FETCH_MAX_ATTEMPTS}`)
    expect(attempts).toBe(GIT_FETCH_MAX_ATTEMPTS)
  })

  test('does not retry another git subcommand', () => {
    let attempts = 0
    const result = runWithGitFetchRetry(['git', 'status'], () => {
      attempts += 1
      return {
        result: 'status failure',
        succeeded: false,
        stderr: "cannot lock ref 'refs/remotes/origin/main'",
      }
    })

    expect(result).toBe('status failure')
    expect(attempts).toBe(1)
  })
})
