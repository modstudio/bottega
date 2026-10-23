export type GitleaksScan = {
  mode: 'history' | 'staged' | 'working-tree'
  args: string[]
}

export type GitleaksScanCheck = {
  mode: GitleaksScan['mode']
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
  return { status: 'pass' }
}
