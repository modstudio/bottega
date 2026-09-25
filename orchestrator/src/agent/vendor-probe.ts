// concern: vendor-probe
/** Owns the vendor-availability probe that clears quota cooldown. Must not know Commander grammar. */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { which } from 'bun'
import { writableDb } from '../database/db.ts'
import { classify, type FailureKind } from '../failure/failure.ts'
import {
  outcomeFromTransport,
  TransportOperationTimeout,
  type TransportResult,
  transportFor,
  withTransportDeadline,
} from '../transport/transport.ts'
import { agentRows, HARNESSES, type Harness, rowAgent } from './agent-registry.ts'

const VENDOR_PROBE_PROMPT = 'Reply with exactly: ok'
const VENDOR_PROBE_JOB = 'vendor-probe'

type VendorProbeResult = {
  ok: boolean
  kind: 'ok' | 'quota' | 'failed'
  message: string
}

type Presentation = { log(value: string): void; setExitCode(code: number): void }

function processEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
}

async function drainTransportEvents(events: AsyncIterable<unknown>): Promise<void> {
  try {
    for await (const _event of events) {
      /* consuming the stream lets transports finish their event lifecycle */
    }
  } catch {
    /* event observation never replaces the probe outcome */
  }
}

function finishProbeRun(
  id: number,
  started: number,
  status: 'ok' | 'failed',
  error: string | null,
  failureKind: string | null,
  outputBytes: number,
): void {
  writableDb()
    .query(
      `UPDATE run SET status=?,latency_ms=?,exit_code=?,output_bytes=?,error=?,failure_kind=? WHERE id=?`,
    )
    .run(status, Date.now() - started, status === 'ok' ? 0 : 1, outputBytes, error, failureKind, id)
}

function vendorText(result: TransportResult, fallback: string): string {
  return result.error?.trim() || result.output.trim() || fallback
}

function failedResult(kind: FailureKind, text: string): VendorProbeResult {
  if (kind === 'quota') return { ok: false, kind: 'quota', message: `vendor quota: ${text}` }
  return { ok: false, kind: 'failed', message: text }
}

async function collectProbe(name: string, agent: ReturnType<typeof rowAgent>, scratch: string) {
  const transport = transportFor(agent.defaultTransport)
  const handle = await transport.start({
    agent,
    cwd: join(scratch, 'cwd'),
    prompt: VENDOR_PROBE_PROMPT,
    outPath: join(scratch, 'probe.out'),
    model: agent.model,
    modelExplicit: true,
    startedAt: Date.now(),
    write: false,
    sandbox: 'read-only',
    env: {
      ...processEnv(),
      ...(agent.env?.() ?? {}),
      ORCH_SCRATCH: scratch,
    },
  })
  const draining = drainTransportEvents(handle.events())
  try {
    const collected = await withTransportDeadline({
      operation: (async () => {
        await transport.prompt(handle, VENDOR_PROBE_PROMPT)
        return handle.collect()
      })(),
      operationName: `${agent.harness} vendor probe; rerun orch probe ${name}`,
      timeoutMs: agent.timeoutMs,
      onTimeout: () => transport.cancel(handle),
    })
    await draining
    return collected
  } finally {
    try {
      handle.kill(9)
    } catch {
      /* exited */
    }
    void draining
  }
}

function settleCollected(
  name: string,
  id: number,
  started: number,
  collected: TransportResult,
): VendorProbeResult {
  const outcome = outcomeFromTransport(collected)
  if (outcome.status === 'ok') {
    finishProbeRun(id, started, 'ok', null, null, Buffer.byteLength(collected.output))
    return { ok: true, kind: 'ok', message: `agent "${name}" is eligible again` }
  }
  const text = vendorText(collected, 'vendor returned no message')
  const kind = classify(text, collected.exitCode)
  finishProbeRun(id, started, 'failed', text, kind, Buffer.byteLength(collected.output))
  return failedResult(kind, text)
}

function settleThrown(id: number, started: number, error: unknown): VendorProbeResult {
  const timedOut = error instanceof TransportOperationTimeout
  const detail = String((error as Error).message ?? error)
  const kind = classify(detail, 1, timedOut)
  finishProbeRun(id, started, 'failed', detail, kind, Buffer.byteLength(detail))
  return failedResult(kind, detail)
}

export async function probeVendor(name: string): Promise<VendorProbeResult> {
  const row = agentRows().find((candidate) => candidate.name === name)
  if (!row) throw new Error(`unknown agent "${name}"`)
  if (!HARNESSES.includes(row.harness as Harness)) {
    throw new Error(`legacy agent "${name}" has no runnable harness`)
  }
  const agent = rowAgent(row)
  if (which(agent.bin, { PATH: process.env.PATH }) === null) {
    throw new Error(`${agent.harness} harness is not installed`)
  }
  const scratch = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'orch-vendor-probe-'))
  mkdirSync(join(scratch, 'cwd'))
  const started = Date.now()
  const inserted = writableDb()
    .query(
      `INSERT INTO run
       (started_at,agent,job,cwd,prompt_sha,prompt_bytes,prompt_head,probe,status,model,transport)
       VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    )
    .get(
      new Date(started).toISOString(),
      name,
      VENDOR_PROBE_JOB,
      join(scratch, 'cwd'),
      createHash('sha256').update(VENDOR_PROBE_PROMPT).digest('hex'),
      Buffer.byteLength(VENDOR_PROBE_PROMPT),
      VENDOR_PROBE_PROMPT.slice(0, 240),
      1,
      'running',
      agent.model,
      agent.defaultTransport,
    ) as { id: number }
  try {
    return settleCollected(name, inserted.id, started, await collectProbe(name, agent, scratch))
  } catch (error) {
    return settleThrown(inserted.id, started, error)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

export async function vendorProbeCommand(name: string, presentation: Presentation): Promise<void> {
  const result = await probeVendor(name)
  presentation.log(result.message)
  if (!result.ok) presentation.setExitCode(1)
}
