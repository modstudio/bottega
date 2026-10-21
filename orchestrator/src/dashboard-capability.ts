import { timingSafeEqual } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import {
  DASHBOARD_CAPABILITY_PATH_ENV,
  DASHBOARD_CAPABILITY_TOKEN_ENV,
  type DashboardCapability,
} from '../../shared/dashboard-capability.ts'
import { pidAlive } from '../../shared/process-identity.ts'

const DASHBOARD_CAPABILITY_PS_TIMEOUT_MS = 10_000

export function dashboardServeCommand(command: string): boolean {
  const words = command.trim().split(/\s+/)
  const frontDoorSource = `cli/${PLATFORM_SLUG}.ts`
  return words.some((word, index) => {
    const next = words[index + 1]
    const after = words[index + 2]
    if (
      (word === PLATFORM_SLUG || word.endsWith(`/bin/${PLATFORM_SLUG}`)) &&
      next === 'dashboard' &&
      after === 'start'
    ) {
      return true
    }
    if (
      (word === frontDoorSource || word.endsWith(`/${frontDoorSource}`)) &&
      next === 'dashboard' &&
      after === 'start'
    ) {
      return true
    }
    return (
      (word === 'hub' ||
        word.endsWith('/bin/hub') ||
        word === 'hub/src/cli.ts' ||
        word.endsWith('/hub/src/cli.ts')) &&
      next === 'serve'
    )
  })
}

/** Verify that this process was launched by the live, same-user hub dashboard. */
export function dashboardCapabilityAuthorized(): boolean {
  const path = process.env[DASHBOARD_CAPABILITY_PATH_ENV]
  const presented = process.env[DASHBOARD_CAPABILITY_TOKEN_ENV]
  if (!path || !presented || typeof process.getuid !== 'function') return false
  try {
    const uid = process.getuid()
    const file = lstatSync(path)
    const dir = lstatSync(dirname(path))
    if (!file.isFile() || file.isSymbolicLink() || !dir.isDirectory() || dir.isSymbolicLink())
      return false
    if (
      file.uid !== uid ||
      dir.uid !== uid ||
      (file.mode & 0o777) !== 0o600 ||
      (dir.mode & 0o777) !== 0o700
    )
      return false
    const capability = JSON.parse(readFileSync(path, 'utf8')) as DashboardCapability
    if (
      !Number.isInteger(capability.pid) ||
      capability.pid < 1 ||
      typeof capability.token !== 'string'
    )
      return false
    const expected = Buffer.from(capability.token)
    const actual = Buffer.from(presented)
    if (
      expected.length !== actual.length ||
      !timingSafeEqual(expected, actual) ||
      !pidAlive(capability.pid)
    )
      return false
    let observed: ReturnType<typeof Bun.spawnSync>
    for (let attempt = 0; ; attempt += 1) {
      observed = Bun.spawnSync(['ps', '-p', String(capability.pid), '-o', 'command='], {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: DASHBOARD_CAPABILITY_PS_TIMEOUT_MS,
      })
      if (observed.exitedDueToTimeout !== true || attempt === 1) break
    }
    if (observed.exitCode !== 0) return false
    return dashboardServeCommand(new TextDecoder().decode(observed.stdout ?? new Uint8Array()))
  } catch {
    return false
  }
}
