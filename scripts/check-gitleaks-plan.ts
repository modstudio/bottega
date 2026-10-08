export type GitleaksScan = {
  mode: 'history' | 'staged' | 'working-tree'
  args: string[]
}

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
