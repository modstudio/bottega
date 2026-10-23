export type GitleaksScan = {
  mode: 'history' | 'staged' | 'working-tree'
  args: string[]
}

export type GitleaksScanCheck = {
  exitCode: number
  log: string
}

export type GitleaksScanDecision = { status: 'pass' } | { status: 'refused'; message: string }

type GitleaksScanInput = {
  rangeCommitCount: number
  range: string
  repository: string
  config: string
}

export function planGitleaksScans(input: GitleaksScanInput): GitleaksScan[] {
  const commonArgs = [
    'git',
    input.repository,
    '--config',
    input.config,
    '--redact',
    '--exit-code',
    '1',
  ]
  if (input.rangeCommitCount > 0) {
    return [{ mode: 'history', args: [...commonArgs, `--log-opts=${input.range}`] }]
  }
  return [
    { mode: 'staged', args: [...commonArgs, '--pre-commit', '--staged'] },
    { mode: 'working-tree', args: [...commonArgs, '--pre-commit'] },
  ]
}

const LEAKS_FOUND = /(?:^|\s)WRN\s+leaks found:\s*\d+/
const XCRUN_CACHE_WARNING =
  /git: error: couldn't create cache file ['"][^'"]*xcrun_db-[^'"]*['"] \(errno=Operation not permitted\)/
const STDERR_NOT_EMPTY = /(?:^|\s)ERR\s+error="stderr is not empty"(?:\s|$)/
const ERROR_LEVEL = /(?:^|\s)ERR(?:\s|$)|(?:^|\s)error:\s/i

export function decideGitleaksScan(check: GitleaksScanCheck): GitleaksScanDecision {
  const lines = Bun.stripANSI(check.log).split(/\r?\n/)
  const leakLine = lines.find((line) => LEAKS_FOUND.test(line))
  if (leakLine) {
    return {
      status: 'refused',
      message:
        'gitleaks reported leaks: ' +
        leakLine.trim() +
        '. Remove the reported secrets and run the printed gitleaks command directly.',
    }
  }
  if (check.exitCode !== 0) {
    return {
      status: 'refused',
      message:
        'gitleaks scanner failed with exit code ' +
        check.exitCode +
        '; see its output above and run the printed gitleaks command directly.',
    }
  }
  const hasXcrunCacheWarning = lines.some((line) => XCRUN_CACHE_WARNING.test(line))
  const errorLine = lines.find(
    (line) =>
      ERROR_LEVEL.test(line) &&
      !XCRUN_CACHE_WARNING.test(line) &&
      !(hasXcrunCacheWarning && STDERR_NOT_EMPTY.test(line)),
  )
  if (errorLine) {
    return {
      status: 'refused',
      message:
        'gitleaks reported an error-level log line: ' +
        errorLine.trim() +
        '. See its output above and run the printed gitleaks command directly.',
    }
  }
  return { status: 'pass' }
}
