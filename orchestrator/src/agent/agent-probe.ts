// concern: agent-probe
/** Owns registration capability probes and their persistence. Must not know CLI grammar. */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { which } from 'bun'
import { nowIso, writableDb } from '../database/db.ts'
import { JOBS } from '../jobs/jobs.ts'
import {
  agentRows,
  HARNESSES,
  type Harness,
  type RegistrationProbeResult,
  refreshAgents,
  rowAgent,
} from './agent-registry.ts'
import type { Caps } from './capabilities.ts'
import { localReachable } from './model-host.ts'

const REGISTRATION_PROBE_FILE = 'probe.txt'
const REGISTRATION_PROBE_SENTINEL = 'REGISTRATION_PROBE_FILE_OK'

export function registrationProbeRequirements(declaredJobs: string[] | null): {
  tool: boolean
  schema: boolean
  mcp: boolean
  file: true
} {
  const needs = { tool: false, schema: false, mcp: false, file: true as const }
  const declared = declaredJobs !== null
  const jobNames = declaredJobs ?? Object.keys(JOBS)
  for (const name of jobNames) {
    const job = JOBS[name]
    if (!job) continue
    if (job.needs.readsRepo) needs.tool = true
    if (job.needs.writesRepo || job.findings) needs.schema = true
    if (job.needs.mcp) needs.mcp = true
  }
  if (!declared) {
    needs.tool = true
    needs.schema = true
    needs.mcp = true
  }
  return needs
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

function namesProbeFile(value: string): boolean {
  const normalized = value.replaceAll('\\', '/')
  return (
    normalized === REGISTRATION_PROBE_FILE ||
    normalized.endsWith(`/${REGISTRATION_PROBE_FILE}`) ||
    new RegExp(`(?:^|[\\s"'/])${REGISTRATION_PROBE_FILE.replace('.', '\\.')}(?:$|[\\s"'])`).test(
      normalized,
    )
  )
}

/** True only for a completed read of the probe file whose result or final reply carries the sentinel. */
export function registrationProbeReadsRepo(
  events: import('../transport/transport.ts').NormalizedEvent[],
  output: string,
): boolean {
  const reads = events.filter(
    (event) =>
      event.kind === 'tool' &&
      event.status === 'completed' &&
      event.toolKind === 'read' &&
      (namesProbeFile(event.target ?? '') || namesProbeFile(event.title)),
  )
  // A CLI transport that surfaces no tool events at all (codex and grok on
  // the cli seam) cannot show the read; the exact sentinel is then the only
  // evidence, and it is sufficient: the sentinel exists nowhere but in the
  // probe file. Where tool events ARE reported, the read must be one of them.
  if (!events.some((event) => event.kind === 'tool')) {
    return output.includes(REGISTRATION_PROBE_SENTINEL)
  }
  if (!reads.length) return false
  return (
    reads.some(
      (event) =>
        event.kind === 'tool' &&
        typeof event.result === 'string' &&
        event.result.includes(REGISTRATION_PROBE_SENTINEL),
    ) || output.includes(REGISTRATION_PROBE_SENTINEL)
  )
}

export function recordAgentProbe(name: string, result: RegistrationProbeResult): void {
  const row = agentRows().find((candidate) => candidate.name === name)
  if (!row) throw new Error(`unknown agent "${name}"`)
  const prior = JSON.parse(row.caps) as Caps & { contextTokens?: number | null }
  const caps = {
    ...prior,
    ...(result.tool.ok !== null ? { readsRepo: result.tool.ok } : {}),
    ...(result.schema.ok !== null ? { schema: result.schema.ok } : {}),
    ...(result.mcp?.verifiable != null ? { mcp: result.mcp.verifiable } : {}),
    ...(result.file?.ok != null ? { replyFile: result.file.ok } : {}),
    ...(result.contextTokens !== null ? { contextTokens: result.contextTokens } : {}),
  }
  writableDb()
    .query('UPDATE agent SET caps=?,probed_at=?,probe_result=? WHERE name=?')
    .run(JSON.stringify(caps), nowIso(), JSON.stringify(result), name)
  if (name === 'qwen36-goose' && result.ok) {
    writableDb()
      .query(`UPDATE agent SET enabled=0,disabled_reason=? WHERE name='qwen36-qwencli'`)
      .run('retired bespoke driver; qwen36-goose passed registration probe')
  }
  refreshAgents()
}

/** Prove capabilities before routing spends a worktree discovering them. */
export async function probeAgent(name: string): Promise<RegistrationProbeResult> {
  const row = agentRows().find((candidate) => candidate.name === name)
  if (!row) throw new Error(`unknown agent "${name}"`)
  const priorCaps = JSON.parse(row.caps) as Caps
  const previous = row.probe_result ? JSON.parse(row.probe_result) : null
  if (previous?.ok === true && previous?.file?.ok === true && priorCaps.replyFile === true) {
    return previous as RegistrationProbeResult
  }
  if (!HARNESSES.includes(row.harness as Harness)) {
    throw new Error(`legacy agent "${name}" has no runnable harness`)
  }
  const agent = rowAgent(row)
  if (which(agent.bin, { PATH: process.env.PATH }) === null)
    throw new Error(`${agent.harness} harness is not installed`)
  const scratch = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'orch-agent-probe-'))
  mkdirSync(join(scratch, 'repo'))
  writeFileSync(join(scratch, 'repo', REGISTRATION_PROBE_FILE), `${REGISTRATION_PROBE_SENTINEL}\n`)
  const schemaPath = join(scratch, 'schema.json')
  writeFileSync(
    schemaPath,
    JSON.stringify({
      type: 'object',
      additionalProperties: false,
      required: ['status'],
      properties: { status: { type: 'string', enum: ['ok'] } },
    }),
  )
  const { transportFor, valueMatchesStrictSchema, withTransportDeadline } = await import(
    '../transport/transport.ts'
  )
  const { mintStdioPingServer, mcpToolCallsObservable } = await import('../mcp/mcp-probe.ts')
  mintStdioPingServer(join(scratch, 'repo'))
  const declared = row.jobs ? (JSON.parse(row.jobs) as string[]) : null
  const needs = registrationProbeRequirements(declared)
  const transport = transportFor(agent.defaultTransport)
  const runOne = async (id: string, prompt: string, schema?: string, mcp = false) => {
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
        `agent-probe-${id}`,
        join(scratch, 'repo'),
        createHash('sha256').update(prompt).digest('hex'),
        Buffer.byteLength(prompt),
        prompt.slice(0, 240),
        1,
        'running',
        agent.model,
        agent.defaultTransport,
      ) as { id: number }
    try {
      const handle = await transport.start({
        agent,
        cwd: join(scratch, 'repo'),
        prompt,
        outPath: join(scratch, `${id}.out`),
        schemaPath: schema,
        model: agent.model,
        modelExplicit: true,
        startedAt: Date.now(),
        write: true,
        sandbox: 'workspace-write',
        writableRoots: [scratch],
        mcp,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
          ),
          ...(agent.env?.() ?? {}),
          ORCH_SCRATCH: scratch,
        },
      })
      const draining = drainTransportEvents(handle.events())
      try {
        const outcome = await withTransportDeadline({
          operation: (async () => {
            await transport.prompt(handle, prompt)
            return handle.collect()
          })(),
          operationName: `${agent.harness} agent probe prompt and collection; inspect harness logs and rerun orch agent probe ${name}`,
          timeoutMs: agent.timeoutMs,
          onTimeout: () => transport.cancel(handle),
        })
        await draining
        writableDb()
          .query(
            `UPDATE run SET status=?,latency_ms=?,exit_code=?,output_bytes=?,error=? WHERE id=?`,
          )
          .run(
            outcome.status === 'ok' ? 'ok' : 'failed',
            Date.now() - started,
            outcome.status === 'ok' ? 0 : 1,
            Buffer.byteLength(outcome.output),
            outcome.status === 'ok' ? null : outcome.output,
            inserted.id,
          )
        return outcome
      } finally {
        try {
          handle.kill(9)
        } catch {
          /* exited */
        }
        void draining
      }
    } catch (error) {
      const detail = String((error as Error).message ?? error)
      writableDb()
        .query(`UPDATE run SET status='failed',latency_ms=?,exit_code=1,error=? WHERE id=?`)
        .run(Date.now() - started, detail, inserted.id)
      return {
        status: 'failed' as const,
        output: detail,
        parsed: null,
        events: [] as import('../transport/transport.ts').NormalizedEvent[],
      }
    }
  }
  const reply = await runOne('reply', 'Reply with exactly: ok')
  const tool = needs.tool
    ? await runOne(
        'tool',
        `Read ${REGISTRATION_PROBE_FILE} with a file tool and reply with exactly its contents.`,
      )
    : {
        status: 'ok' as const,
        output: 'skipped: not required for declared jobs',
        events: [] as import('../transport/transport.ts').NormalizedEvent[],
      }
  const replyPath = join(scratch, 'reply.json')
  rmSync(replyPath, { force: true })
  const structured = await runOne(
    'schema',
    needs.schema
      ? 'Write {"status":"ok"} to $ORCH_SCRATCH/reply.json, then return a final message using the supplied schema.'
      : 'Write {"status":"ok"} to $ORCH_SCRATCH/reply.json, then reply with exactly: ok',
    needs.schema ? schemaPath : undefined,
  )
  const mcpRun =
    needs.mcp || !declared
      ? await runOne(
          'mcp',
          'Call the ping MCP tool and reply with exactly its result.',
          undefined,
          true,
        )
      : {
          status: 'ok' as const,
          output: 'skipped: not required for declared jobs',
          events: [] as import('../transport/transport.ts').NormalizedEvent[],
        }
  const parsedSchema = (() => {
    try {
      return JSON.parse(structured.parsed?.text ?? structured.output)
    } catch {
      return null
    }
  })()
  const fileOutput = existsSync(replyPath) ? readFileSync(replyPath, 'utf8') : ''
  const parsedFile = (() => {
    try {
      return JSON.parse(fileOutput)
    } catch {
      return null
    }
  })()
  const prior = JSON.parse(row.caps) as Caps & { contextTokens?: number | null }
  const previousProbe = row.probe_result ? JSON.parse(row.probe_result) : null
  const attempts = Array.isArray(previousProbe?.attempts) ? previousProbe.attempts : []
  let contextTokens = Object.hasOwn(prior, 'contextTokens') ? (prior.contextTokens ?? null) : null
  let contextSource: RegistrationProbeResult['contextSource'] = contextTokens ? 'declared' : null
  if (row.base_url) {
    const health = await localReachable(4000, row.base_url)
    if (health.contextTokens) {
      contextTokens = health.contextTokens
      contextSource = 'harness'
    }
  }
  const mcpVerifiable = needs.mcp ? mcpToolCallsObservable(mcpRun.events, mcpRun.output) : null
  const replyOk = reply.status === 'ok' && reply.output.trim().toLowerCase() === 'ok'
  const toolOk = needs.tool
    ? tool.status === 'ok' && registrationProbeReadsRepo(tool.events, tool.output)
    : null
  const schemaOk = needs.schema ? structured.status === 'ok' && parsedSchema?.status === 'ok' : null
  const fileOk = valueMatchesStrictSchema(JSON.parse(readFileSync(schemaPath, 'utf8')), parsedFile)
  const perJob = Object.fromEntries(
    Object.keys(JOBS).map((jobName) => {
      const job = JOBS[jobName]
      return [
        jobName,
        {
          reply: replyOk,
          ...(job?.needs.readsRepo ? { tool: toolOk } : {}),
          ...(job?.needs.writesRepo || job?.findings ? { schema: schemaOk } : {}),
          ...(job?.needs.mcp ? { mcp: mcpVerifiable } : {}),
        },
      ]
    }),
  )
  const result: RegistrationProbeResult = {
    harness: row.harness,
    ok: false,
    reply: { ok: replyOk, output: reply.output },
    tool: {
      // ACP reports the harness tool lifecycle separately from its final prose.
      // Goose emits an empty final message after a successful read, so the
      // sentinel may live in the tool result rather than the echoed reply.
      // Any completed tool is not enough: the read must target the probe file
      // and the exact sentinel must appear in that result or the final reply.
      ok: toolOk,
      output: tool.output,
      toolEvents: tool.events.filter((e) => e.kind === 'tool').length,
      statuses: tool.events.filter((e) => e.kind === 'tool').map((e) => e.status ?? 'unknown'),
    },
    schema: { ok: schemaOk, output: structured.output },
    file: { ok: fileOk, output: fileOutput },
    mcp: { verifiable: mcpVerifiable, output: mcpRun.output },
    jobs: perJob,
    contextTokens,
    contextSource,
    ...(attempts.length ? { attempts } : {}),
  }
  // Cloud agents declare no ceiling deliberately (canon: not the binding
  // constraint here); only a local endpoint must report its window.
  result.ok =
    result.reply.ok &&
    (!needs.tool || toolOk === true) &&
    fileOk === true &&
    (!needs.schema || schemaOk === true) &&
    (!needs.mcp || mcpVerifiable === true) &&
    (contextTokens !== null || !row.base_url)
  recordAgentProbe(name, result)
  return result
}
