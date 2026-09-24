// concern: service-revision
/** Identity and revision policy for long-running hub processes. */

import { installRoot } from '../../shared/install-root.ts'
import { pidAlive } from '../../shared/process-identity.ts'
import { db, writeTransaction } from './db.ts'

export const REVISION_CHECK_MS = 60_000

export type RevisionRead = { revision: string; error: null } | { revision: null; error: string }

export type ServiceIdentity = {
  holder: string
  pid: number
  revision: string | null
  revisionError: string | null
  currentRevisionError: string | null
  startedAt: string
}

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
  | { status: 'unreadable'; side: 'startup' | 'current'; reason: string }
  | { status: 'current'; revision: string }
  | { status: 'stale'; startedRevision: string; currentRevision: string; startedAt: string }

export function serviceRevisionStatus(
  identity: ServiceIdentity,
  alive: boolean,
  current: RevisionRead,
): ServiceRevisionStatus {
  if (!alive) return { status: 'gone' }
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

function readIdentity(service: 'serve' | 'collect'): ServiceIdentity | null {
  const row = db()
    .query<{ value: string }, [string]>('SELECT value FROM setting WHERE key = ?')
    .get(settingKey(service))
  if (!row) return null
  try {
    return JSON.parse(row.value) as ServiceIdentity
  } catch {
    return null
  }
}

export function startRevisionMonitor(
  service: 'serve' | 'collect',
  holder: string,
  drain: () => Promise<void>,
): void {
  const started = readInstallHead()
  const identity: ServiceIdentity = {
    holder,
    pid: process.pid,
    revision: started.revision,
    revisionError: started.error,
    currentRevisionError: null,
    startedAt: new Date().toISOString(),
  }
  writeIdentity(service, identity)
  let lastCheck = Date.now()
  const timer = setInterval(async () => {
    const now = Date.now()
    const current = readInstallHead()
    const decision = revisionDecision(identity.revision, current, now, lastCheck)
    lastCheck = now
    if (current.error !== identity.currentRevisionError) {
      identity.currentRevisionError = current.error
      writeIdentity(service, identity)
    }
    if (decision !== 'restart' || current.revision === null || identity.revision === null) return
    clearInterval(timer)
    await drain()
    console.log(
      `hub: ${service} revision changed ${identity.revision} -> ${current.revision}; exiting for restart`,
    )
    process.exit(0)
  }, REVISION_CHECK_MS)
}

export function formatServiceRevisionDoctor(): string[] {
  const current = readInstallHead()
  return (['serve', 'collect'] as const).map((service) => {
    const identity = readIdentity(service)
    if (!identity) return `${service.padEnd(14)} gone (no identity recorded)`
    const status = serviceRevisionStatus(identity, pidAlive(identity.pid), current)
    if (status.status === 'gone') {
      return `${service.padEnd(14)} gone (pid ${identity.pid}, holder ${identity.holder})`
    }
    if (status.status === 'unreadable') {
      return `${service.padEnd(14)} unreadable (${status.side} HEAD: ${status.reason})`
    }
    if (status.status === 'current') {
      return `${service.padEnd(14)} current ${status.revision} (pid ${identity.pid}, started ${identity.startedAt})`
    }
    return `${service.padEnd(14)} stale ${status.startedRevision} -> ${status.currentRevision} (started ${status.startedAt})`
  })
}
