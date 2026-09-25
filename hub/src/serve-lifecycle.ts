// concern: serve-lifecycle
/**
 * Owns the dashboard server's local identity record and shutdown. Must not
 * know the hub database, collection, reports, tasks, or web application.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, join } from 'node:path'
import { pidAlive, processStartTime } from '../../shared/process-identity.ts'
import { concernStateDirectory, type StateEnvironment } from '../../shared/state-directory.ts'

export type ServeRecord = {
  pid: number
  port: number
  checkout: string | null
  startTime: string | null
  startedAt: string
}

export type ServeStopDecision = 'none' | 'exited' | 'stop' | 'foreign'

export type ServeProbeResult = 'refused' | 'accepted' | 'inconclusive'

export type ServeListenerOwner = {
  pid: number
  command: string | null
  cwd: string | null
  startTime: string | null
}

export type ServeDownDecision =
  | { kind: 'down'; owners: [] }
  | { kind: 'own' | 'foreign' | 'unknown'; owners: ServeListenerOwner[] }

export function serveRecordPath(
  port: number,
  env: StateEnvironment = process.env as StateEnvironment,
): string {
  return join(concernStateDirectory('hub', env), '.serve', `${port}.json`)
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
    (parsed.checkout !== undefined &&
      parsed.checkout !== null &&
      typeof parsed.checkout !== 'string') ||
    (parsed.startTime !== null && typeof parsed.startTime !== 'string') ||
    typeof parsed.startedAt !== 'string'
  ) {
    throw new Error(`hub: invalid serve record ${path}`)
  }
  return {
    pid: Number(parsed.pid),
    port: Number(parsed.port),
    checkout: parsed.checkout ?? null,
    startTime: parsed.startTime ?? null,
    startedAt: parsed.startedAt,
  }
}

function commandServesCheckout(command: string, cwd: string | null, checkout: string): boolean {
  if (!/(?:^|\s)serve(?:\s|$)/.test(command)) return false
  const cli = join(checkout, 'hub', 'src', 'cli.ts')
  if (command.includes(cli)) return true
  return cwd === checkout && /(?:^|\s)hub\/src\/cli\.ts(?:\s|$)/.test(command)
}

/** Decide the checkout-specific teardown question from already observed process facts. */
export function serveDownDecision(
  probe: ServeProbeResult,
  owners: ServeListenerOwner[] | null,
  checkout: string,
  record: ServeRecord | null,
): ServeDownDecision {
  if (probe === 'refused') return { kind: 'down', owners: [] }
  if (!owners?.length) return { kind: 'unknown', owners: [] }

  const own = owners.filter(
    (owner) =>
      commandServesCheckout(owner.command ?? '', owner.cwd, checkout) ||
      (record !== null &&
        record.checkout === checkout &&
        owner.pid === record.pid &&
        record.startTime !== null &&
        owner.startTime === record.startTime),
  )
  if (own.length) return { kind: 'own', owners: own }

  // A command identifies a different program or checkout. A relative hub command
  // without a readable cwd does not establish which checkout owns it.
  const unidentified = owners.filter(
    (owner) =>
      owner.command === null ||
      (/(?:^|\s)hub\/src\/cli\.ts(?:\s|$)/.test(owner.command) && owner.cwd === null),
  )
  return unidentified.length
    ? { kind: 'unknown', owners: unidentified }
    : { kind: 'foreign', owners }
}

function probeServeDown(port: number, timeoutMs = 1_000): Promise<ServeProbeResult> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let settled = false
    const finish = (result: ServeProbeResult) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }
    socket.once('connect', () => finish('accepted'))
    socket.once('error', (error: NodeJS.ErrnoException) =>
      finish(error.code === 'ECONNREFUSED' ? 'refused' : 'inconclusive'),
    )
    socket.setTimeout(timeoutMs, () => finish('inconclusive'))
  })
}

function processCommand(pid: number): string | null {
  try {
    const inspected = Bun.spawnSync(['ps', '-o', 'command=', '-p', String(pid)], {
      env: { PATH: process.env.PATH ?? '', LC_ALL: 'C', LANG: 'C' },
      stdout: 'pipe',
      stderr: 'ignore',
    })
    if (inspected.exitCode !== 0) return null
    return inspected.stdout.toString().trim() || null
  } catch {
    return null
  }
}

function processCwd(pid: number): string | null {
  try {
    const inspected = Bun.spawnSync(['lsof', '-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      stdout: 'pipe',
      stderr: 'ignore',
    })
    if (inspected.exitCode !== 0) return null
    return (
      inspected.stdout
        .toString()
        .split('\n')
        .find((line) => line.startsWith('n'))
        ?.slice(1) ?? null
    )
  } catch {
    return null
  }
}

function listeningProcessIds(port: number): number[] | null {
  try {
    const inspected = Bun.spawnSync(['lsof', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (inspected.exitCode !== 0) return null
    return [
      ...new Set(
        inspected.stdout
          .toString()
          .split('\n')
          .filter((line) => line.startsWith('p'))
          .map((line) => Number(line.slice(1)))
          .filter((pid) => Number.isSafeInteger(pid) && pid > 1 && pidAlive(pid)),
      ),
    ]
  } catch {
    return null
  }
}

/** Ask whether this checkout's hub process is still serving on the port. */
export async function checkServeDown(
  port: number,
  checkout = process.cwd(),
): Promise<ServeDownDecision> {
  const probe = await probeServeDown(port)
  if (probe === 'refused') return { kind: 'down', owners: [] }
  const pids = listeningProcessIds(port)
  const owners =
    pids?.map((pid) => ({
      pid,
      command: processCommand(pid),
      cwd: processCwd(pid),
      startTime: processStartTime(pid),
    })) ?? null
  return serveDownDecision(probe, owners, checkout, parseServeRecord(serveRecordPath(port)))
}

/** Print the established owner behind a serve-down result; true means teardown may proceed. */
export function reportServeDown(port: number, decision: ServeDownDecision): boolean {
  const owners = decision.owners
    .map((owner) => `pid ${owner.pid} (${owner.command ?? 'unknown command'})`)
    .join(', ')
  if (decision.kind === 'down') {
    console.log(`hub: this checkout is not serving on port ${port}`)
    return true
  }
  if (decision.kind === 'foreign') {
    console.log(
      `hub: this checkout is not serving on port ${port}; ignored foreign listener ${owners}`,
    )
    return true
  }
  if (decision.kind === 'own') {
    console.error(`hub: this checkout is still serving on port ${port}: ${owners}`)
  } else {
    console.error(
      `hub: port ${port} has a listener whose owner could not be established${owners ? `: ${owners}` : ''}`,
    )
  }
  return false
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
    checkout: process.cwd(),
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
