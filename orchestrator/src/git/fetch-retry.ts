// concern: git fetch retry
/** Decides whether a failed git fetch lost a remote-ref compare-and-swap race. */

export const GIT_FETCH_MAX_ATTEMPTS = 3
export const GIT_FETCH_RETRY_BASE_DELAY_MS = 25

export type GitFetchRetryDecision = { retry: false } | { retry: true; delayMs: number }

export type GitFetchAttempt<T> = {
  result: T
  succeeded: boolean
  stderr: string
}

export function isGitFetchInvocation(argv: string[]): boolean {
  const subcommand = argv[0] === 'git' ? 1 : 0
  if (argv[subcommand] !== 'fetch') return false
  for (let index = subcommand + 1; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--') return argv[index + 1] === 'origin'
    if (argument && !argument.startsWith('-')) return argument === 'origin'
  }
  return false
}

/** Attempts are one-based and include the failed attempt being classified. */
export function decideGitFetchRetry(attempt: number, stderr: string): GitFetchRetryDecision {
  if (attempt >= GIT_FETCH_MAX_ATTEMPTS || !stderr.includes('cannot lock ref')) {
    return { retry: false }
  }
  return { retry: true, delayMs: GIT_FETCH_RETRY_BASE_DELAY_MS * attempt }
}

export function runWithGitFetchRetry<T>(argv: string[], runner: () => GitFetchAttempt<T>): T {
  for (let attempt = 1; ; attempt += 1) {
    const outcome = runner()
    if (outcome.succeeded || !isGitFetchInvocation(argv)) return outcome.result
    const decision = decideGitFetchRetry(attempt, outcome.stderr)
    if (!decision.retry) return outcome.result
    Bun.sleepSync(decision.delayMs)
  }
}
