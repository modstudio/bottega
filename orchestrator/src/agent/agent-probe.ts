// concern: agent-probe
/** Owns registration capability probes and their persistence. Must not know CLI grammar. */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { which } from 'bun'
import type { ConfigEnvironment } from '../../../shared/config-directory.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { nowIso, writableDb } from '../database/db.ts'
import { JOBS } from '../jobs/jobs.ts'
import { nextRunNumber } from '../run/run-number.ts'
import { runProbeTurn } from './agent-probe-turn.ts'
import {
  agentRows,
  HARNESSES,
  type Harness,
  type RegistrationProbeResult,
  refreshAgents,
  rowAgent,
} from './agent-registry.ts'
import {
  probeAgentWrites,
  writingCapabilityPolicy,
  writingProbePorts,
} from './agent-writing-probe.ts'
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

/** True when a named read of the probe file is evidenced, or the exact sentinel is the successful output and no read-kind event exists. */
export function registrationProbeReadsRepo(
  events: import('../transport/transport.ts').NormalizedEvent[],
  output: string,
): boolean {
  const reads = events.filter(
    (event): event is Extract<(typeof events)[number], { kind: 'tool' }> =>
      event.kind === 'tool' && event.toolKind === 'read',
  )
  if (reads.length) {
    const namesFile = (event: (typeof reads)[number]) =>
      namesProbeFile(event.target ?? '') || namesProbeFile(event.title)
    if (!reads.some(namesFile)) return false
    const completed = reads.filter((event) => event.status === 'completed' && namesFile(event))
    if (completed.length) {
      return (
        completed.some(
          (event) =>
            typeof event.result === 'string' && event.result.includes(REGISTRATION_PROBE_SENTINEL),
        ) || output.includes(REGISTRATION_PROBE_SENTINEL)
      )
    }
  }
  return output.includes(REGISTRATION_PROBE_SENTINEL)
}

export function recordAgentProbe(name: string, result: RegistrationProbeResult): void {
  const row = agentRows().find((candidate) => candidate.name === name)
  if (!row) throw new Error(`unknown agent "${name}"`)
  const prior = JSON.parse(row.caps) as Caps & { contextTokens?: number | null }
  const writing = writingCapabilityPolicy(row.transport, result.writing?.ok)
  const caps = {
    ...prior,
    ...(result.tool.ok !== null ? { readsRepo: result.tool.ok } : {}),
    ...(result.schema.ok !== null ? { schema: result.schema.ok } : {}),
    ...(result.mcp?.verifiable != null ? { mcp: result.mcp.verifiable } : {}),
    ...(result.file?.ok != null ? { replyFile: result.file.ok } : {}),
    ...(writing.writesRepo !== null ? { writesRepo: writing.writesRepo } : {}),
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

/** Record the overall successful registration probe as operational availability evidence. */
export function recordSuccessfulRegistrationProbe(name: string): void {
  const row = agentRows().find((candidate) => candidate.name === name)
  if (!row) throw new Error(`unknown agent "${name}"`)
  const prompt = 'registration probe passed'
  writableDb()
    .query(
      `INSERT INTO run
       (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,probe,status,latency_ms,exit_code,output_bytes,model,transport)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      newRecordId(),
      nextRunNumber(writableDb()),
      nowIso(),
      name,
      'agent-probe',
      createHash('sha256').update(prompt).digest('hex'),
      Buffer.byteLength(prompt),
      prompt,
      1,
      'ok',
      0,
      0,
      0,
      row.model,
      row.transport,
    )
}

/** Prove capabilities before routing spends a worktree discovering them. */
export type AgentProbeInputs = { path?: string; environment: ConfigEnvironment }

export function registrationProbeCacheReusable(
  transport: 'cli' | 'acp',
  previous: RegistrationProbeResult | null,
  replyFile: boolean | undefined,
): boolean {
  return Boolean(
    previous?.ok === true &&
      previous.file?.ok === true &&
      replyFile === true &&
      writingCapabilityPolicy(transport, previous.writing?.ok).jobSuccess,
  )
}

export async function probeAgent(
  name: string,
  inputs: AgentProbeInputs,
): Promise<RegistrationProbeResult> {
  const row = agentRows().find((candidate) => candidate.name === name)
  if (!row) throw new Error(`unknown agent "${name}"`)
  const priorCaps = JSON.parse(row.caps) as Caps
  const previous = row.probe_result ? JSON.parse(row.probe_result) : null
  if (registrationProbeCacheReusable(row.transport, previous, priorCaps.replyFile))
    return previous as RegistrationProbeResult
  if (!HARNESSES.includes(row.harness as Harness))
    throw new Error(`legacy agent "${name}" has no runnable harness`)
  const agent = rowAgent(row)
  if (which(agent.bin, { PATH: inputs.path }) === null)
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
  const { transportFor, valueMatchesStrictSchema } = await import('../transport/transport.ts')
  const { mintStdioPingServer, mcpToolCallsObservable } = await import('../mcp/mcp-probe.ts')
  mintStdioPingServer(join(scratch, 'repo'))
  const declared = row.jobs ? (JSON.parse(row.jobs) as string[]) : null
  const needs = registrationProbeRequirements(declared)
  const transport = transportFor(agent.defaultTransport)
  const runOne = (
    id: string,
    prompt: string,
    schema?: string,
    mcp = false,
    writing?: import('./agent-writing-probe.ts').WritingProbeConfinement,
  ) => runProbeTurn({ name, scratch, agent, transport, id, prompt, schema, mcp, writing })
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
  const writing = await probeAgentWrites(
    {
      transport: row.transport,
      scratch,
      agent,
      path: inputs.path,
      environment: inputs.environment,
    },
    writingProbePorts(({ cwd, prompt, profile }) =>
      runOne('writing', prompt, undefined, false, { cwd, profile }),
    ),
  )
  const writingPolicy = writingCapabilityPolicy(row.transport, writing.ok)
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
          ...(job?.needs.writesRepo ? { writing: writingPolicy.jobSuccess } : {}),
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
    writing,
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
    writingPolicy.jobSuccess &&
    (contextTokens !== null || !row.base_url)
  recordAgentProbe(name, result)
  return result
}
