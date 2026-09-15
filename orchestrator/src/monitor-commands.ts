// concern: monitor-commands
/** Owns monitor invocation, notice delivery authority, reporting, and exit mapping. Must not know CLI grammar. */

import { timingSafeEqual } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs'
import { basename, dirname } from 'node:path'
import {
  MONITOR_CAPABILITY_PATH_ENV,
  MONITOR_CAPABILITY_TOKEN_ENV,
  type MonitorCapability,
} from '../../shared/monitor-capability.ts'
import { sessionId } from './db.ts'
import { failingCanonEvalSlugs } from './evals.ts'
import { displayConditions, formatMonitorPass, monitor, monitorHistory } from './monitor.ts'
import { claimMonitorNotices, markMonitorNoticesDelivered } from './monitor-notices.ts'
import type { MonitorNotice } from './monitor-types.ts'
import { pidAlive } from './process-liveness.ts'

type Options = {
  ackNotices?: string
  notices: boolean
  history: boolean
  backstop: boolean
  limit: number
  json: boolean
}
type Presentation = {
  log(value: string): void
  error(value: string): void
  write(value: string): Promise<void>
  setExitCode(code: number): void
}

function deliveryAuthorized(): boolean {
  const path = process.env[MONITOR_CAPABILITY_PATH_ENV],
    presented = process.env[MONITOR_CAPABILITY_TOKEN_ENV]
  if (!path || !presented || typeof process.getuid !== 'function') return false
  let fd: number | undefined
  try {
    const uid = process.getuid(),
      dir = lstatSync(dirname(path))
    if (
      !dir.isDirectory() ||
      dir.isSymbolicLink() ||
      dir.uid !== uid ||
      (dir.mode & 0o777) !== 0o700
    )
      return false
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const file = fstatSync(fd)
    if (!file.isFile() || file.uid !== uid || (file.mode & 0o777) !== 0o600) return false
    const capability = JSON.parse(readFileSync(fd, 'utf8')) as MonitorCapability
    if (
      !Number.isInteger(capability.pid) ||
      capability.pid < 1 ||
      typeof capability.token !== 'string'
    )
      return false
    const expected = Buffer.from(capability.token),
      actual = Buffer.from(presented)
    if (
      expected.length !== actual.length ||
      !timingSafeEqual(expected, actual) ||
      capability.pid !== process.ppid ||
      !pidAlive(capability.pid)
    )
      return false
    const observed = Bun.spawnSync(['/bin/ps', '-p', String(capability.pid), '-o', 'command='], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (observed.exitCode !== 0) return false
    const words = new TextDecoder().decode(observed.stdout).trim().split(/\s+/)
    let executable = words[0]
    if (/^(?:python(?:3(?:\.\d+)?)?|ba?sh|zsh|dash)$/i.test(executable ? basename(executable) : ''))
      executable = words[1]
    if (!executable) return false
    const hooks = new Set([
      realpathSync(new URL('../hooks/orch-heartbeat.sh', import.meta.url).pathname),
      realpathSync(new URL('../hooks/session-brief.py', import.meta.url).pathname),
    ])
    try {
      return hooks.has(realpathSync(executable))
    } catch {
      return false
    }
  } catch {
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export async function monitorCommand(options: Options, presentation: Presentation): Promise<void> {
  if (options.ackNotices !== undefined) return acknowledge(options.ackNotices)
  if (options.notices) return showNotices(options.json, presentation)
  if (options.history) return showHistory(options.limit, options.json, presentation)
  await runMonitor(options, presentation)
}

function acknowledge(ids: string): void {
  const sid = sessionId()
  if (!sid) throw new Error('monitor notice acknowledgement requires CLAUDE_CODE_SESSION_ID')
  if (!deliveryAuthorized())
    throw new Error('monitor notice acknowledgement requires a live delivery-hook capability')
  markMonitorNoticesDelivered(sid, ids.split(',') as MonitorNotice['noticeId'][])
}

async function showNotices(json: boolean, presentation: Presentation): Promise<void> {
  const sid = sessionId()
  if (!sid) throw new Error('monitor notices require CLAUDE_CODE_SESSION_ID')
  const rows = claimMonitorNotices(sid)
  if (json) await presentation.write(`${JSON.stringify(rows)}\n`)
  else
    for (const condition of rows)
      presentation.log(`MONITOR ${condition.kind} ${condition.subject}: ${condition.detail}`)
}

async function showHistory(
  limit: number,
  json: boolean,
  presentation: Presentation,
): Promise<void> {
  const rows = monitorHistory(limit)
  if (json) await presentation.write(`${JSON.stringify(rows)}\n`)
  else
    for (const row of rows)
      presentation.log(
        formatMonitorPass(
          `monitor ${row.id}  ${row.started_at}  ${row.trigger}  ${row.findings} found, ${row.errors} errors`,
          displayConditions(row.conditions),
        ).join('\n'),
      )
}

async function runMonitor(options: Options, presentation: Presentation): Promise<void> {
  const result = await monitor(options.backstop ? 'backstop' : 'invoked')
  if (options.json) await presentation.write(`${JSON.stringify(result)}\n`)
  else {
    const failing = failingCanonEvalSlugs(),
      lines = [`canon: ${result.canon.findings} stale references in ${result.canon.docs} docs`]
    if (failing.length) lines.push(`canon evals: ${failing.length} failing (${failing.join(', ')})`)
    if (result.conditions.length || result.errors.length) {
      lines.push(
        ...formatMonitorPass(
          `monitor ${result.id}: ${result.conditions.length} condition(s), ${result.errors.length} observation error(s)`,
          result.conditions,
        ),
      )
      for (const error of result.errors) presentation.error(`  observation failed: ${error}`)
    }
    await presentation.write(`${lines.join('\n')}\n`)
  }
  if (result.errors.length) presentation.setExitCode(1)
  else if (result.conditions.length) presentation.setExitCode(2)
}
