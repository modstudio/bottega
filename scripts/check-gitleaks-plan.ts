export type GitleaksScan = {
  mode: 'history' | 'staged' | 'working-tree'
  args: string[]
}

export type GitleaksScanCheck =
  | { mode: 'history'; expectedCommitCount: number; exitCode: number; log: string }
  | {
      mode: Exclude<GitleaksScan['mode'], 'history'>
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

const ERROR_LEVEL = /(?:^|\s)ERR(?:\s|$)/
const COMMITS_SCANNED = /(?:^|\s)INF\s+(\d+)\s+commits scanned\./

export function decideGitleaksScan(check: GitleaksScanCheck): GitleaksScanDecision {
  const lines = Bun.stripANSI(check.log).split(/\r?\n/)
  const errorLine = lines.find((line) => ERROR_LEVEL.test(line))
  const reportedCount = lines.reduce<number | undefined>((found, line) => {
    if (found !== undefined) return found
    const match = line.match(COMMITS_SCANNED)
    return match ? Number(match[1]) : undefined
  }, undefined)
  const findings: string[] = []
  let stderrRemedy = false

  if (check.exitCode !== 0) {
    findings.push(`expected exit code 0; gitleaks reported exit code ${check.exitCode}`)
  }
  if (errorLine) {
    findings.push(`expected no error-level log line; gitleaks reported: ${errorLine.trim()}`)
    stderrRemedy = true
  }
  // Gitleaks omits merge commits, so its count is a nonzero floor rather than an exact count.
  if (
    check.mode === 'history' &&
    check.expectedCommitCount > 0 &&
    (reportedCount === undefined ||
      reportedCount === 0 ||
      reportedCount > check.expectedCommitCount)
  ) {
    findings.push(
      `expected between 1 and ${check.expectedCommitCount} commits scanned; gitleaks reported ${reportedCount === undefined ? 'no commits-scanned line' : reportedCount}`,
    )
    stderrRemedy = true
  }

  if (findings.length === 0) return { status: 'pass' }
  const remedy =
    check.exitCode !== 0
      ? 'Gitleaks reported leaks or failed; see its output above and run the printed gitleaks command directly.'
      : 'Run the printed gitleaks command directly.'
  return {
    status: 'refused',
    message: `${findings.join('. ')}. ${remedy}${stderrRemedy ? ' Clear whatever makes git write to stderr.' : ''}`,
  }
}
