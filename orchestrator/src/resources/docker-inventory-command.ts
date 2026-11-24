// concern: Docker inventory process adapter and availability decision

export type DockerHostEvidence = {
  executablePaths: string[]
  daemonSocketPaths: string[]
}

export type DockerInventoryAvailability =
  | { kind: 'proceed' }
  | { kind: 'docker-absent' }
  | { kind: 'fail'; reason: string }

export type DockerInventoryAvailabilityFacts =
  | { ok: true }
  | ({ ok: false; reason: string; executableAbsent: boolean } & DockerHostEvidence)

/** Decide inventory availability from already gathered facts. */
export function decideDockerInventoryAvailability(
  input: DockerInventoryAvailabilityFacts,
): DockerInventoryAvailability {
  if (input.ok) return { kind: 'proceed' }
  if (!input.executableAbsent) return { kind: 'fail', reason: input.reason }
  const executable = input.executablePaths[0]
  if (executable) {
    const directory = executable.slice(0, executable.lastIndexOf('/'))
    return {
      kind: 'fail',
      reason: `docker not on PATH but ${executable} exists; add ${directory} to PATH`,
    }
  }
  const socket = input.daemonSocketPaths[0]
  if (socket)
    return {
      kind: 'fail',
      reason: `docker not on PATH but daemon socket ${socket} exists; put docker on PATH or set DOCKER_HOST`,
    }
  return { kind: 'docker-absent' }
}

export type DockerInventoryCommandResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; kind: 'docker-absent' }
  | { ok: false; kind: 'fail'; reason: string }

/** Structurally identify a missing executable without depending on runtime message text. */
export function executableAbsentFrom(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null | undefined)?.code === 'ENOENT'
}

/** Classify one thrown Docker inventory spawn, probing the host only after ENOENT. */
export function classifyDockerInventorySpawnError(
  error: unknown,
  gatherEvidence: () => DockerHostEvidence,
): Exclude<DockerInventoryAvailability, { kind: 'proceed' }> {
  const executableAbsent = executableAbsentFrom(error)
  const availability = decideDockerInventoryAvailability({
    ok: false,
    reason: (error as Error).message,
    executableAbsent,
    ...(executableAbsent ? gatherEvidence() : { executablePaths: [], daemonSocketPaths: [] }),
  })
  return availability.kind === 'proceed'
    ? { kind: 'fail', reason: (error as Error).message }
    : availability
}

/** Run and structurally classify a Docker inventory command. */
export function runDockerInventoryCommand(
  command: string[],
  timeoutMs: number,
  gatherEvidence: () => DockerHostEvidence,
): DockerInventoryCommandResult {
  let result: ReturnType<typeof Bun.spawnSync>
  try {
    result = Bun.spawnSync(command, {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: timeoutMs,
    })
  } catch (error) {
    const availability = classifyDockerInventorySpawnError(error, gatherEvidence)
    return availability.kind === 'fail'
      ? { ok: false, kind: 'fail', reason: availability.reason }
      : { ok: false, kind: 'docker-absent' }
  }
  if (result.exitedDueToTimeout) {
    return { ok: false, kind: 'fail', reason: `timed out after ${timeoutMs}ms` }
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      kind: 'fail',
      reason: result.stderr?.toString().trim() || `exit ${result.exitCode}`,
    }
  }
  return {
    ok: true,
    stdout: result.stdout?.toString() ?? '',
    stderr: result.stderr?.toString() ?? '',
  }
}
