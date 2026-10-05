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
import { assetPath } from '../../../shared/install-root.ts'
import {
  MONITOR_CAPABILITY_PATH_ENV,
  MONITOR_CAPABILITY_TOKEN_ENV,
  type MonitorCapability,
} from '../../../shared/monitor-capability.ts'
import { pidAlive } from '../../../shared/process-identity.ts'
import { failingCanonEvalSlugs } from '../canon/evals.ts'
import { sessionId } from '../database/db.ts'
import {
  displayConditions,
  formatMonitorPass,
  MonitorStoreBusyError,
  monitor,
  monitorHistory,
} from './monitor.ts'
import {
  claimMonitorNoticesWithHosted,
  markMonitorNoticesDeliveredWithHosted,
} from './monitor-notices.ts'
import {
  formatStoreWriteLockReport,
  type StoreWriteLockReport,
  storeWriteLockReport,
} from './monitor-store-write-lock.ts'
import type { MonitorNotice } from './monitor-types.ts'

type Options = {
  ackNotices?: string
  notices: boolean
  history: boolean
  backstop: boolean
  lockHolder: boolean
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
      realpathSync(assetPath('orchestrator', 'hooks', 'orch-heartbeat.sh')),
      realpathSync(assetPath('orchestrator', 'hooks', 'session-brief.py')),
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
  if (options.lockHolder) return showLockHolder(options.json, presentation)
  if (options.ackNotices !== undefined) return acknowledge(options.ackNotices)
  if (options.notices) return showNotices(options.json, presentation)
  if (options.history) return showHistory(options.limit, options.json, presentation)
  await runMonitor(options, presentation)
}

async function showLockHolder(json: boolean, presentation: Presentation): Promise<void> {
  const report = await storeWriteLockReport()
  if (json) await presentation.write(`${JSON.stringify(report)}\n`)
  else await presentation.write(`${formatStoreWriteLockReport(report)}\n`)
  if (!report.supported) presentation.setExitCode(1)
}

function lockCondition(report: Extract<StoreWriteLockReport, { supported: true }>) {
  return {
    kind: 'store-write-lock-held',
    subject: report.store,
    since: null,
    ageMs: null,
    detail: formatStoreWriteLockReport(report),
    action: 'inspect the named process and run before retrying an orch write',
    pid: report.pid,
    command: report.command,
    runId: report.runId,
    isRunSupervisor: report.isRunSupervisor,
    classification: report.classification,
    sampleCount: report.sampleCount,
  }
}

async function acknowledge(ids: string): Promise<void> {
  const sid = sessionId()
  if (!sid) throw new Error('monitor notice acknowledgement requires CLAUDE_CODE_SESSION_ID')
  if (!deliveryAuthorized())
    throw new Error('monitor notice acknowledgement requires a live delivery-hook capability')
  await markMonitorNoticesDeliveredWithHosted(sid, ids.split(',') as MonitorNotice['noticeId'][])
}

async function showNotices(json: boolean, presentation: Presentation): Promise<void> {
  const sid = sessionId()
  if (!sid) throw new Error('monitor notices require CLAUDE_CODE_SESSION_ID')
  const rows = await claimMonitorNoticesWithHosted(sid)
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

async function monitorResultOrReport(
  options: Options,
  presentation: Presentation,
): Promise<Awaited<ReturnType<typeof monitor>> | null> {
  try {
    return await monitor(options.backstop ? 'backstop' : 'invoked')
  } catch (error) {
    if (!(error instanceof MonitorStoreBusyError)) throw error
    const report = await storeWriteLockReport()
    if (!report.supported) {
      presentation.error(`${error.message}; ${formatStoreWriteLockReport(report)}`)
      presentation.setExitCode(1)
      return null
    }
    const condition = lockCondition(report)
    if (options.json) await presentation.write(`${JSON.stringify({ conditions: [condition] })}\n`)
    else await presentation.write(`${formatStoreWriteLockReport(report)}\n`)
    presentation.setExitCode(2)
    return null
  }
}

async function runMonitor(options: Options, presentation: Presentation): Promise<void> {
  const result = await monitorResultOrReport(options, presentation)
  if (!result) return
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
