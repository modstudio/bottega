type CpuTime = { user: number | bigint; system: number | bigint }

type LandingBase = {
  commit: string
  command: string[]
  cpuTime: CpuTime
}

export function resolveLandingBase(root: string, checkName: string): LandingBase {
  const landingBranch = process.env.GITHUB_BASE_REF || 'main'
  const remoteBranch = `origin/${landingBranch}`
  const command = ['git', 'merge-base', remoteBranch, 'HEAD']
  const result = Bun.spawnSync(command, {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim()
    throw new Error(
      `${checkName} could not resolve CI merge base with ${remoteBranch}${detail ? `: ${detail}` : ''}`,
    )
  }
  return {
    commit: result.stdout.toString().trim(),
    command,
    cpuTime: result.resourceUsage.cpuTime,
  }
}
