// concern: git fetch retry
/** Decides whether a failed git fetch lost a remote-ref compare-and-swap race. */

export const GIT_FETCH_MAX_ATTEMPTS = 3
export const GIT_FETCH_RETRY_BASE_DELAY_MS = 25

export type GitFetchRetryDecision = { retry: false } | { retry: true; delayMs: number }

/** Attempts are one-based and include the failed attempt being classified. */
export function decideGitFetchRetry(attempt: number, stderr: string): GitFetchRetryDecision {
  if (attempt >= GIT_FETCH_MAX_ATTEMPTS || !stderr.includes('cannot lock ref')) {
    return { retry: false }
  }
  return { retry: true, delayMs: GIT_FETCH_RETRY_BASE_DELAY_MS * attempt }
}
