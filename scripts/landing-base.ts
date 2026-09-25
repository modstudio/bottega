type CpuTime = { user: number | bigint; system: number | bigint }

type LandingBase = {
  commit: string
  command: string[]
  cpuTime: CpuTime
}

export function resolveLandingBase(root: string, checkName: string): LandingBase {
  const landingBranch = process.env.GITHUB_BASE_REF || 'main'
  return resolveRemoteLandingBase(root, checkName, landingBranch)
}

function resolveRemoteLandingBase(
  root: string,
  checkName: string,
  landingBranch: string,
): LandingBase {
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

/** Resolve only the registered landing branch, refusing contradictory CI metadata. */
export function resolveRegisteredLandingBase(
  root: string,
  checkName: string,
  registeredLandingBranch: string,
): LandingBase {
  const githubBase = process.env.GITHUB_BASE_REF?.trim()
  if (githubBase && githubBase !== registeredLandingBranch) {
    throw new Error(
      `${checkName} refuses GITHUB_BASE_REF ${githubBase}: the project register names ${registeredLandingBranch} as trunk`,
    )
  }
  return resolveRemoteLandingBase(root, checkName, registeredLandingBranch)
}
