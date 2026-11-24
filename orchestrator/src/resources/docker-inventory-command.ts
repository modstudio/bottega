// concern: Docker inventory process adapter and availability decision

export type DockerInventoryAvailability = 'proceed' | 'docker-absent' | 'fail'

export function decideDockerInventoryAvailability(input: {
  ok: boolean
  executableAbsent: boolean
}): DockerInventoryAvailability {
  if (input.ok) return 'proceed'
  return input.executableAbsent ? 'docker-absent' : 'fail'
}

export type DockerInventoryCommandResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; executableAbsent: boolean; reason: string }

/** Run and structurally classify a Docker inventory command. */
export function runDockerInventoryCommand(
  command: string[],
  timeoutMs: number,
): DockerInventoryCommandResult {
  let result: ReturnType<typeof Bun.spawnSync>
  try {
    result = Bun.spawnSync(command, {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: timeoutMs,
    })
  } catch (error) {
    return {
      ok: false,
      executableAbsent: (error as NodeJS.ErrnoException).code === 'ENOENT',
      reason: (error as Error).message,
    }
  }
  if (result.exitedDueToTimeout) {
    return {
      ok: false,
      executableAbsent: false,
      reason: `timed out after ${timeoutMs}ms`,
    }
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      executableAbsent: false,
      reason: result.stderr?.toString().trim() || `exit ${result.exitCode}`,
    }
  }
  return {
    ok: true,
    stdout: result.stdout?.toString() ?? '',
    stderr: result.stderr?.toString() ?? '',
  }
}
