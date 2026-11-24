// concern: Docker inventory process adapter and availability decision

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Glob } from 'bun'

export const KNOWN_DOCKER_EXECUTABLE_PATHS = [
  '/usr/bin/docker',
  '/usr/local/bin/docker',
  '/opt/homebrew/bin/docker',
  '~/.docker/bin/docker',
] as const

export const KNOWN_DOCKER_DAEMON_SOCKET_PATHS = [
  'DOCKER_HOST unix path',
  '/var/run/docker.sock',
  '$XDG_RUNTIME_DIR/docker.sock',
  '~/.docker/run/docker.sock',
  '~/.colima/*/docker.sock',
] as const

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
  if (executable)
    return { kind: 'fail', reason: `docker not on PATH but ${executable} exists` }
  const socket = input.daemonSocketPaths[0]
  if (socket)
    return { kind: 'fail', reason: `docker not on PATH but daemon socket ${socket} exists` }
  return { kind: 'docker-absent' }
}

type DockerEvidenceProbeInput = {
  env?: Record<string, string | undefined>
  home?: string
  exists?: (path: string) => boolean
  colimaSockets?: (home: string) => string[]
}

function defaultColimaSockets(home: string): string[] {
  return [
    ...new Glob('.colima/*/docker.sock').scanSync({
      cwd: home,
      absolute: true,
      onlyFiles: false,
    }),
  ]
}

/** Gather existence-only evidence after an ENOENT inventory spawn. */
export function gatherDockerHostEvidence(input: DockerEvidenceProbeInput = {}): DockerHostEvidence {
  const env = input.env ?? process.env
  const home = input.home ?? homedir()
  const exists = input.exists ?? existsSync
  const executableCandidates = KNOWN_DOCKER_EXECUTABLE_PATHS.map((path) =>
    path.startsWith('~/') ? join(home, path.slice(2)) : path,
  )
  const socketCandidates: string[] = []
  if (env.DOCKER_HOST?.startsWith('unix://')) {
    const path = env.DOCKER_HOST!.slice('unix://'.length)
    if (path) socketCandidates.push(path)
  }
  socketCandidates.push('/var/run/docker.sock')
  if (env.XDG_RUNTIME_DIR) socketCandidates.push(join(env.XDG_RUNTIME_DIR, 'docker.sock'))
  socketCandidates.push(join(home, '.docker/run/docker.sock'))
  socketCandidates.push(...(input.colimaSockets ?? defaultColimaSockets)(home))
  return {
    executablePaths: executableCandidates.filter(exists),
    daemonSocketPaths: [...new Set(socketCandidates)].filter(exists),
  }
}

export const dockerHostEvidenceProbe = { gather: gatherDockerHostEvidence }

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
): Exclude<DockerInventoryAvailability, { kind: 'proceed' }> {
  const executableAbsent = executableAbsentFrom(error)
  const availability = decideDockerInventoryAvailability({
    ok: false,
    reason: (error as Error).message,
    executableAbsent,
    ...(executableAbsent
      ? dockerHostEvidenceProbe.gather()
      : { executablePaths: [], daemonSocketPaths: [] }),
  })
  return availability.kind === 'proceed'
    ? { kind: 'fail', reason: (error as Error).message }
    : availability
}

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
    const availability = classifyDockerInventorySpawnError(error)
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
