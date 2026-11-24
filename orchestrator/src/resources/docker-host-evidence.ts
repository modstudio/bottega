// concern: existence-only host evidence for Docker inventory availability

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Glob } from 'bun'
import type { DockerHostEvidence } from './docker-inventory-command.ts'

const KNOWN_DOCKER_EXECUTABLE_PATHS = [
  '/usr/bin/docker',
  '/usr/local/bin/docker',
  '/opt/homebrew/bin/docker',
  '/snap/bin/docker',
  '~/.docker/bin/docker',
  '~/.rd/bin/docker',
] as const

type EvidenceContext = {
  env: Record<string, string | undefined>
  home: string
  colimaSockets: (home: string) => string[]
}

const KNOWN_DOCKER_DAEMON_SOCKET_PATHS = [
  ({ env }: EvidenceContext) =>
    env.DOCKER_HOST?.startsWith('unix://') ? [env.DOCKER_HOST.slice('unix://'.length)] : [],
  () => ['/var/run/docker.sock'],
  ({ env }: EvidenceContext) =>
    env.XDG_RUNTIME_DIR ? [join(env.XDG_RUNTIME_DIR, 'docker.sock')] : [],
  ({ home }: EvidenceContext) => [join(home, '.docker/run/docker.sock')],
  ({ home }: EvidenceContext) => [join(home, '.rd/docker.sock')],
  ({ home }: EvidenceContext) => [join(home, '.orbstack/run/docker.sock')],
  ({ home, colimaSockets }: EvidenceContext) => colimaSockets(home),
] as const

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
  const context = {
    env: input.env ?? process.env,
    home: input.home ?? homedir(),
    colimaSockets: input.colimaSockets ?? defaultColimaSockets,
  }
  const exists = input.exists ?? existsSync
  const executableCandidates = KNOWN_DOCKER_EXECUTABLE_PATHS.map((path) =>
    path.startsWith('~/') ? join(context.home, path.slice(2)) : path,
  )
  const socketCandidates = KNOWN_DOCKER_DAEMON_SOCKET_PATHS.flatMap((paths) => paths(context))
  return {
    executablePaths: executableCandidates.filter(exists),
    daemonSocketPaths: [...new Set(socketCandidates)].filter(Boolean).filter(exists),
  }
}

export const dockerHostEvidenceProbe = { gather: gatherDockerHostEvidence }
