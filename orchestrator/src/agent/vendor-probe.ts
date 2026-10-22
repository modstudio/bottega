// concern: vendor-probe
/** Owns the vendor-availability probe that clears quota cooldown. Must not know Commander grammar. */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { which } from 'bun'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { writableDb } from '../database/db.ts'
import { classify, type FailureKind } from '../failure/failure.ts'
import { nextRunNumber } from '../run/run-number.ts'
import {
  outcomeFromTransport,
  TransportOperationTimeout,
  type TransportResult,
  transportFor,
  withTransportDeadline,
} from '../transport/transport.ts'
import { agentRows, HARNESSES, type Harness, rowAgent } from './agent-registry.ts'
import { resolveEndpointApiKeyEnv } from './endpoint-api-key.ts'

const VENDOR_PROBE_PROMPT = 'Reply with exactly: ok'
const VENDOR_PROBE_JOB = 'vendor-probe'

type VendorProbeResult = {
  ok: boolean
  kind: 'ok' | 'quota' | 'failed'
  message: string
}

type VendorProbeOutcome = { ok: true } | { ok: false; kind: FailureKind; text: string }

type Presentation = { log(value: string): void; setExitCode(code: number): void }

function vendorProbeSettlement(
  name: string,
  outcome: VendorProbeOutcome,
  enabled: boolean,
  disabledReason: string | null,
): VendorProbeResult {
  if (!outcome.ok) {
    if (outcome.kind === 'quota')
      return { ok: false, kind: 'quota', message: `vendor quota: ${outcome.text}` }
    return { ok: false, kind: 'failed', message: outcome.text }
  }
  if (!enabled) {
    return {
      ok: true,
      kind: 'ok',
      message:
        `probe passed; agent "${name}" is still disabled (${disabledReason}); ` +
        `re-enable with ${PLATFORM_SLUG} agent show set ${name} --enabled true`,
    }
  }
  return { ok: true, kind: 'ok', message: `agent "${name}" is eligible again` }
}

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
  id: string,
  started: number,
  status: 'ok' | 'failed',
  error: string | null,
  failureKind: string | null,
  outputBytes: number,
): void {
  writableDb()
    .query(
      `UPDATE run SET status=?,latency_ms=?,exit_code=?,output_bytes=?,error=?,failure_kind=? WHERE record_id=?`,
    )
    .run(status, Date.now() - started, status === 'ok' ? 0 : 1, outputBytes, error, failureKind, id)
}

function vendorText(result: TransportResult, fallback: string): string {
  return result.error?.trim() || result.output.trim() || fallback
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
      ...(await resolveEndpointApiKeyEnv(agent)),
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
      operationName: `${agent.harness} vendor probe; rerun ${PLATFORM_SLUG} agent probe ${name}`,
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
  id: string,
  started: number,
  collected: TransportResult,
  enabled: boolean,
  disabledReason: string | null,
): VendorProbeResult {
  const outcome = outcomeFromTransport(collected)
  if (outcome.status === 'ok') {
    finishProbeRun(id, started, 'ok', null, null, Buffer.byteLength(collected.output))
    return vendorProbeSettlement(name, { ok: true }, enabled, disabledReason)
  }
  const text = vendorText(collected, 'vendor returned no message')
  const kind = classify(text, collected.exitCode)
  finishProbeRun(id, started, 'failed', text, kind, Buffer.byteLength(collected.output))
  return vendorProbeSettlement(name, { ok: false, kind, text }, enabled, disabledReason)
}

function settleThrown(
  name: string,
  id: string,
  started: number,
  error: unknown,
  enabled: boolean,
  disabledReason: string | null,
): VendorProbeResult {
  const timedOut = error instanceof TransportOperationTimeout
  const detail = String((error as Error).message ?? error)
  const kind = classify(detail, 1, timedOut)
  finishProbeRun(id, started, 'failed', detail, kind, Buffer.byteLength(detail))
  return vendorProbeSettlement(name, { ok: false, kind, text: detail }, enabled, disabledReason)
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
       (record_id,number,started_at,agent,job,cwd,prompt_sha,prompt_bytes,prompt_head,probe,status,model,transport)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING record_id`,
    )
    .get(
      newRecordId(),
      nextRunNumber(writableDb()),
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
    ) as { record_id: string }
  try {
    return settleCollected(
      name,
      inserted.record_id,
      started,
      await collectProbe(name, agent, scratch),
      agent.enabled !== false,
      agent.disabledReason ?? null,
    )
  } catch (error) {
    return settleThrown(
      name,
      inserted.record_id,
      started,
      error,
      agent.enabled !== false,
      agent.disabledReason ?? null,
    )
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

export async function vendorProbeCommand(name: string, presentation: Presentation): Promise<void> {
  const result = await probeVendor(name)
  presentation.log(result.message)
  if (!result.ok) presentation.setExitCode(1)
}
