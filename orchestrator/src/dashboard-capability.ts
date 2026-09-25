import { timingSafeEqual } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  DASHBOARD_CAPABILITY_PATH_ENV,
  DASHBOARD_CAPABILITY_TOKEN_ENV,
  type DashboardCapability,
} from '../../shared/dashboard-capability.ts'
import { pidAlive } from '../../shared/process-identity.ts'

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
    const observed = Bun.spawnSync(['ps', '-p', String(capability.pid), '-o', 'command='], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (observed.exitCode !== 0) return false
    const words = new TextDecoder().decode(observed.stdout).trim().split(/\s+/)
    return words.some(
      (word, index) =>
        (word === 'hub' || word.endsWith('/bin/hub') || word.endsWith('/hub/src/cli.ts')) &&
        words[index + 1] === 'serve',
    )
  } catch {
    return false
  }
}
