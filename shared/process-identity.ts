// concern: process-identity
/**
 * Knows how to identify an operating-system process. Must not know runs,
 * worktrees, databases, routing, transports, or command adapters.
 */
import { platform } from 'node:os'

const PROCESS_START_TIME =
  /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ 0-3]\d [0-2]\d:[0-5]\d:[0-5]\d \d{4}$/

/** Test whether a recorded process still exists without signalling it. */
export function pidAlive(pid: number | null): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Locale-independent process birth; malformed or unreadable identity is unknown. */
export function processStartTime(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  if (platform() !== 'darwin' && platform() !== 'linux') return null
  try {
    const inspected = Bun.spawnSync(['ps', '-o', 'lstart=', '-p', String(pid)], {
      env: { PATH: process.env.PATH ?? '', LC_ALL: 'C', LANG: 'C' },
      stdout: 'pipe',
      stderr: 'ignore',
    })
    if (inspected.exitCode !== 0) return null
    const value = inspected.stdout.toString().trim()
    return PROCESS_START_TIME.test(value) ? value : null
  } catch {
    return null
  }
}

export type PidRecordIdentity = 'live' | 'dead' | 'reused' | 'unknown'

/**
 * Compare a recorded pid against its recorded birth time.
 * Unknown is not live: destruction and sampling require an established identity.
 */
export function pidRecordIdentity(
  pid: number | null | undefined,
  recordedStartTime: string | null | undefined,
  observedStartTime: (pid: number) => string | null = processStartTime,
): PidRecordIdentity {
  if (!pid || pid <= 1 || !pidAlive(pid)) return 'dead'
  if (!recordedStartTime) return 'unknown'
  const actual = observedStartTime(pid)
  if (actual === null) return 'unknown'
  return actual === recordedStartTime ? 'live' : 'reused'
}
