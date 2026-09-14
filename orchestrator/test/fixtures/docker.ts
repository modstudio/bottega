import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanDockerBin as preloadDockerBin } from '../preload.ts'

export const cleanDockerBin = preloadDockerBin

export function fakeDocker(containers: string[], volumes: string[]): { dir: string; env: Record<string, string> } {
  const fakeDir = mkdtempSync(join(tmpdir(), 'orch-fake-docker-'))
  const script = join(fakeDir, 'docker')
  writeFileSync(script, `#!/bin/sh
case "$1 $2" in
  "ps -a") printf '%s\\n' "$FAKE_DOCKER_CONTAINERS" ;;
  "volume ls") printf '%s\\n' "$FAKE_DOCKER_VOLUMES" ;;
  *) exit 9 ;;
esac
`)
  chmodSync(script, 0o755)
  return { dir: fakeDir, env: {
    PATH: `${fakeDir}:${process.env.PATH ?? ''}`,
    FAKE_DOCKER_CONTAINERS: containers.join('\n'),
    FAKE_DOCKER_VOLUMES: volumes.join('\n'),
  } }
}

export function fakeDockerCommand(body: string): { dir: string; env: Record<string, string> } {
  const fakeDir = mkdtempSync(join(tmpdir(), 'orch-fake-docker-command-'))
  const script = join(fakeDir, 'docker')
  writeFileSync(script, `#!/bin/sh\n${body}\n`)
  chmodSync(script, 0o755)
  return { dir: fakeDir, env: { PATH: `${fakeDir}:${process.env.PATH ?? ''}` } }
}
