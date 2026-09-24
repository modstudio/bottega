// concern: service-revision
/** Identity and revision policy for long-running hub processes. */

import { installRoot } from '../../shared/install-root.ts'
import {
  type PidRecordIdentity,
  pidRecordIdentity,
  processStartTime,
} from '../../shared/process-identity.ts'
import { db, writeTransaction } from './db.ts'

export const REVISION_CHECK_MS = 60_000

export type RevisionRead = { revision: string; error: null } | { revision: null; error: string }

export type ServiceIdentity = {
  holder: string
  pid: number
  processStartTime: string | null
  revision: string | null
  revisionError: string | null
  currentRevisionError: string | null
  startedAt: string
}

export type IdentityRead =
  | { status: 'missing' }
  | { status: 'valid'; identity: ServiceIdentity }
  | { status: 'unreadable'; reason: string }

export type ProcessIdentityRead =
  | { status: 'live' }
  | { status: 'dead' | 'reused' }
  | { status: 'unreadable'; reason: string }

export type RevisionDecision = 'wait' | 'continue' | 'restart'

export function revisionDecision(
  startedRevision: string | null,
  currentRevision: RevisionRead,
  now: number,
  lastCheck: number,
): RevisionDecision {
  if (now - lastCheck < REVISION_CHECK_MS) return 'wait'
  if (startedRevision === null || currentRevision.revision === null) return 'continue'
  return startedRevision === currentRevision.revision ? 'continue' : 'restart'
}

export type ServiceRevisionStatus =
  | { status: 'gone' }
  | {
      status: 'unreadable'
      side: 'recorded' | 'process' | 'startup' | 'current'
      reason: string
    }
  | { status: 'current'; revision: string }
  | { status: 'stale'; startedRevision: string; currentRevision: string; startedAt: string }

export function serviceRevisionStatus(
  identity: ServiceIdentity,
  processIdentity: ProcessIdentityRead,
  current: RevisionRead,
): ServiceRevisionStatus {
  if (processIdentity.status === 'dead' || processIdentity.status === 'reused') {
    return { status: 'gone' }
  }
  if (processIdentity.status === 'unreadable') {
    return { status: 'unreadable', side: 'process', reason: processIdentity.reason }
  }
  if (identity.revision === null) {
    return {
      status: 'unreadable',
      side: 'startup',
      reason: identity.revisionError ?? 'startup HEAD was not recorded',
    }
  }
  if (current.revision === null) {
    return { status: 'unreadable', side: 'current', reason: current.error }
  }
  if (identity.revision === current.revision) {
    return { status: 'current', revision: identity.revision }
  }
  return {
    status: 'stale',
    startedRevision: identity.revision,
    currentRevision: current.revision,
    startedAt: identity.startedAt,
  }
}

function readInstallHead(): RevisionRead {
  try {
    const result = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
      cwd: installRoot(),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const revision = result.stdout.toString().trim()
    if (result.exitCode === 0 && revision) return { revision, error: null }
    return {
      revision: null,
      error: result.stderr.toString().trim() || `git rev-parse HEAD exited ${result.exitCode}`,
    }
  } catch (error) {
    return { revision: null, error: error instanceof Error ? error.message : String(error) }
  }
}

const settingKey = (service: 'serve' | 'collect') => `service.${service}`

function writeIdentity(service: 'serve' | 'collect', identity: ServiceIdentity): void {
  writeTransaction((conn) =>
    conn
      .query(
        `INSERT INTO setting (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(settingKey(service), JSON.stringify(identity)),
  )
}

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function nullableString(value: unknown): value is string | null {
  return value === null || nonemptyString(value)
}

export function parseServiceIdentity(value: string): IdentityRead {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    return {
      status: 'unreadable',
      reason: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { status: 'unreadable', reason: 'identity must be an object' }
  }
  const candidate = parsed as Record<string, unknown>
  const fields: Array<[string, boolean]> = [
    ['holder', nonemptyString(candidate.holder)],
    ['pid', Number.isSafeInteger(candidate.pid) && Number(candidate.pid) > 1],
    ['processStartTime', nullableString(candidate.processStartTime)],
    ['revision', nullableString(candidate.revision)],
    ['revisionError', nullableString(candidate.revisionError)],
    ['currentRevisionError', nullableString(candidate.currentRevisionError)],
    [
      'startedAt',
      nonemptyString(candidate.startedAt) && !Number.isNaN(Date.parse(String(candidate.startedAt))),
    ],
  ]
  const invalid = fields.find(([, valid]) => !valid)
  if (invalid) return { status: 'unreadable', reason: `invalid or missing ${invalid[0]}` }
  return { status: 'valid', identity: candidate as ServiceIdentity }
}

function readIdentity(service: 'serve' | 'collect'): IdentityRead {
  const row = db()
    .query<{ value: string }, [string]>('SELECT value FROM setting WHERE key = ?')
    .get(settingKey(service))
  return row ? parseServiceIdentity(row.value) : { status: 'missing' }
}

function processIdentityRead(identity: ServiceIdentity): ProcessIdentityRead {
  const status: PidRecordIdentity = pidRecordIdentity(identity.pid, identity.processStartTime)
  if (status === 'live' || status === 'dead' || status === 'reused') return { status }
  return {
    status: 'unreadable',
    reason:
      identity.processStartTime === null
        ? 'process birth time was not recorded'
        : 'process birth time could not be read',
  }
}

type MaybePromise = void | Promise<void>

export type RevisionMonitorAdapters = {
  readHead: () => RevisionRead
  writeIdentity: (service: 'serve' | 'collect', identity: ServiceIdentity) => MaybePromise
  processStartTime: (pid: number) => string | null
  now: () => number
  setInterval: (callback: () => void, milliseconds: number) => ReturnType<typeof setInterval>
  clearInterval: (timer: ReturnType<typeof setInterval>) => void
  log: (message: string) => void
  exit: (code: number) => void
}

const revisionMonitorAdapters: RevisionMonitorAdapters = {
  readHead: readInstallHead,
  writeIdentity,
  processStartTime,
  now: Date.now,
  setInterval,
  clearInterval,
  log: console.log,
  exit: process.exit,
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function startRevisionMonitor(
  service: 'serve' | 'collect',
  holder: string,
  drain: () => MaybePromise,
  release: () => MaybePromise,
  adapters: RevisionMonitorAdapters = revisionMonitorAdapters,
): void {
  const started = adapters.readHead()
  const identity: ServiceIdentity = {
    holder,
    pid: process.pid,
    processStartTime: adapters.processStartTime(process.pid),
    revision: started.revision,
    revisionError: started.error,
    currentRevisionError: null,
    startedAt: new Date(adapters.now()).toISOString(),
  }
  try {
    const written = adapters.writeIdentity(service, identity)
    if (written) {
      void written.catch((error) =>
        adapters.log(`hub: ${service} identity write failed: ${errorMessage(error)}`),
      )
    }
  } catch (error) {
    adapters.log(`hub: ${service} identity write failed: ${errorMessage(error)}`)
  }

  let lastCheck = adapters.now()
  let restarting = false
  const timer = adapters.setInterval(() => {
    void (async () => {
      if (restarting) return
      try {
        const now = adapters.now()
        const current = adapters.readHead()
        const decision = revisionDecision(identity.revision, current, now, lastCheck)
        lastCheck = now
        if (current.error !== identity.currentRevisionError) {
          identity.currentRevisionError = current.error
          try {
            await adapters.writeIdentity(service, identity)
          } catch (error) {
            adapters.log(`hub: ${service} identity write failed: ${errorMessage(error)}`)
          }
        }
        if (decision !== 'restart' || current.revision === null || identity.revision === null)
          return
        restarting = true
        adapters.log(
          `hub: ${service} revision changed ${identity.revision} -> ${current.revision}; exiting for restart`,
        )
        try {
          await drain()
        } catch (error) {
          adapters.log(`hub: ${service} drain failed: ${errorMessage(error)}`)
        }
        try {
          await release()
        } catch (error) {
          adapters.log(`hub: ${service} lease release failed: ${errorMessage(error)}`)
        }
        try {
          adapters.clearInterval(timer)
        } catch (error) {
          adapters.log(`hub: ${service} timer cleanup failed: ${errorMessage(error)}`)
        }
        adapters.exit(0)
      } catch (error) {
        adapters.log(`hub: ${service} revision check failed: ${errorMessage(error)}`)
      }
    })()
  }, REVISION_CHECK_MS)
}

export function formatServiceRevisionDoctor(): string[] {
  const current = readInstallHead()
  return (['serve', 'collect'] as const).map((service) => {
    const recorded = readIdentity(service)
    if (recorded.status === 'missing') return `${service.padEnd(14)} gone (no identity recorded)`
    if (recorded.status === 'unreadable') {
      return `${service.padEnd(14)} unreadable (recorded identity: ${recorded.reason})`
    }
    const { identity } = recorded
    const status = serviceRevisionStatus(identity, processIdentityRead(identity), current)
    if (status.status === 'gone') {
      return `${service.padEnd(14)} gone (pid ${identity.pid}, holder ${identity.holder})`
    }
    if (status.status === 'unreadable') {
      return `${service.padEnd(14)} unreadable (${status.side}: ${status.reason})`
    }
    if (status.status === 'current') {
      return `${service.padEnd(14)} current ${status.revision} (pid ${identity.pid}, started ${identity.startedAt})`
    }
    return `${service.padEnd(14)} stale ${status.startedRevision} -> ${status.currentRevision} (started ${status.startedAt})`
  })
}
