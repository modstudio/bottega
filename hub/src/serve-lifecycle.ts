// concern: serve-lifecycle
/**
 * Owns the dashboard server's local identity record and shutdown. Must not
 * know the hub database, collection, reports, tasks, or web application.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, join } from 'node:path'
import { pidAlive, processStartTime } from '../../shared/process-identity.ts'

export type ServeRecord = {
  pid: number
  port: number
  startTime: string | null
  startedAt: string
}

export type ServeStopDecision = 'none' | 'exited' | 'stop' | 'foreign'

const SERVE_DIRECTORY = new URL('../.serve/', import.meta.url).pathname.replace(/\/$/, '')

export function serveRecordPath(port: number): string {
  return join(SERVE_DIRECTORY, `${port}.json`)
}

export function serveStopDecision(
  record: ServeRecord | null,
  alive: boolean,
  actualStartTime: string | null,
): ServeStopDecision {
  if (record === null) return 'none'
  if (!alive) return 'exited'
  return actualStartTime !== null && actualStartTime === record.startTime ? 'stop' : 'foreign'
}

function parseServeRecord(path: string): ServeRecord | null {
  if (!existsSync(path)) return null
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ServeRecord>
  if (
    !Number.isSafeInteger(parsed.pid) ||
    Number(parsed.pid) <= 1 ||
    !Number.isSafeInteger(parsed.port) ||
    Number(parsed.port) < 0 ||
    Number(parsed.port) > 65_535 ||
    (parsed.startTime !== null && typeof parsed.startTime !== 'string') ||
    typeof parsed.startedAt !== 'string'
  ) {
    throw new Error(`hub: invalid serve record ${path}`)
  }
  return {
    pid: Number(parsed.pid),
    port: Number(parsed.port),
    startTime: parsed.startTime ?? null,
    startedAt: parsed.startedAt,
  }
}

function removeRecordIfOwned(path: string, pid: number): void {
  try {
    if (parseServeRecord(path)?.pid === pid) rmSync(path)
  } catch {
    // A record changed or became unreadable after this process wrote it. It no
    // longer establishes ownership, so leave it for inspection.
  }
}

/** Write this server's identity and arrange for owned cleanup on every exit path. */
export function ownServeRecord(port: number): void {
  const path = serveRecordPath(port)
  const record: ServeRecord = {
    pid: process.pid,
    port,
    startTime: processStartTime(process.pid),
    startedAt: new Date().toISOString(),
  }
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)

  const cleanup = () => removeRecordIfOwned(path, process.pid)
  process.once('exit', cleanup)
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.prependOnceListener(signal, () => {
      cleanup()
      process.exit(0)
    })
  }
}

async function waitUntilExited(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (pidAlive(pid) && Date.now() < deadline) {
    await Bun.sleep(50)
  }
  return !pidAlive(pid)
}

export async function stopRecordedServe(port: number): Promise<boolean> {
  const path = serveRecordPath(port)
  const record = parseServeRecord(path)
  const actualStartTime = record && pidAlive(record.pid) ? processStartTime(record.pid) : null
  const decision = serveStopDecision(
    record,
    Boolean(record && pidAlive(record.pid)),
    actualStartTime,
  )

  if (decision === 'none') {
    console.log(`hub: no server recorded for port ${port} in this checkout`)
    return true
  }
  if (decision === 'exited') {
    rmSync(path, { force: true })
    console.log(`hub: recorded server for port ${port} already exited`)
    return true
  }
  if (decision === 'foreign') {
    console.error(
      `hub: pid ${record!.pid} recorded for port ${port} is a different process now ` +
        `(start time ${record!.startTime ?? 'unreadable'} vs ${actualStartTime ?? 'unreadable'}); not stopping it`,
    )
    return false
  }

  const pid = record!.pid
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // The process exited after its identity was checked.
  }
  let gone = await waitUntilExited(pid, 5_000)
  if (!gone) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // The process exited between the final poll and the signal.
    }
    gone = await waitUntilExited(pid, 2_000)
  }
  removeRecordIfOwned(path, pid)
  if (gone) return true
  console.error(`hub: pid ${pid} recorded for port ${port} survived SIGTERM and SIGKILL`)
  return false
}

/** True when loopback accepts no TCP connection before the deadline. */
export function servePortIsFree(port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let settled = false
    const finish = (free: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(free)
    }
    socket.once('connect', () => finish(false))
    socket.once('error', () => finish(true))
    socket.setTimeout(timeoutMs, () => finish(true))
  })
}
