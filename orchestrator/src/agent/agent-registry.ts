// concern: agent-registry
/** Owns persisted agent rows, hydration, cache, and mutations. Must not know probes or model-host state. */
import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { DB_PATH, db as dbForAgents, writableDb } from '../database/db.ts'
import { jobContextBudget, OUTPUT_RESERVE, PROMPT_BYTES_PER_TOKEN } from '../jobs/jobs.ts'
import { type Agent, assertResumableAgent, BUILTIN_AGENTS } from './agents.ts'
import type { Caps } from './capabilities.ts'
import type { OpenRouterRecordedBudget } from './openrouter-key-budget.ts'

export const HARNESSES = ['codex', 'grok', 'opencode', 'goose', 'claude-code'] as const
const BACKENDS = ['vllm', 'ollama', 'lmstudio', 'vendor'] as const
export type Harness = (typeof HARNESSES)[number]
export function harnessIdentity(value: string | undefined): Harness | null {
  return HARNESSES.includes(value as Harness) ? (value as Harness) : null
}
export type Backend = (typeof BACKENDS)[number]
export type AgentRow = {
  name: string
  harness: string
  backend: string | null
  model: string
  base_url: string | null
  api_key_secret: string | null
  transport: 'cli' | 'acp'
  caps: string
  billing: Agent['billing']
  operated_by: Agent['operatedBy']
  enabled: number
  disabled_reason: string | null
  probed_at: string | null
  probe_result: string | null
  jobs: string | null
  preferred_jobs: string | null
  max_concurrent: number | null
  route_metered: number
  trains_on_inputs: number
}

/** Goose's own default context limit and the measured working budget for Goose runs. */
export const GOOSE_CONTEXT_CEILING = 128_000

/**
 * Turn bound for a Goose run of a job that does not write the repository.
 * The ceiling sits above the p99 of OK Goose review-lens runs' model calls,
 * so it stops a runaway without cutting a normal run.
 */
export const GOOSE_READING_MAX_TURNS = 150

/**
 * The context limit a Goose worker runs under, bounded by the served window,
 * the job budget, and the Goose ceiling. Inline prompt material may raise the
 * ceiling enough to hold that prompt plus `OUTPUT_RESERVE`. No job means no
 * per-job limit to set, so Goose's own default applies.
 */
export function gooseContextLimit(
  servedWindow: number | null,
  jobContextTokens: number | null,
  promptBytes: number | null,
): number | null {
  if (jobContextTokens === null) return null
  const promptTokens = promptBytes === null ? 0 : Math.ceil(promptBytes / PROMPT_BYTES_PER_TOKEN)
  const budget = jobContextBudget(jobContextTokens) + promptTokens
  const workingLimit = Math.min(
    budget,
    Math.max(GOOSE_CONTEXT_CEILING, promptTokens + OUTPUT_RESERVE),
  )
  return servedWindow === null ? workingLimit : Math.min(servedWindow, workingLimit)
}

function rowLaunchEnvironment(
  row: AgentRow,
  jobContextTokens: number | null,
  promptBytes: number | null,
  writesRepo: boolean | null,
): Record<string, string> {
  if (!row.base_url) return {}
  const stored = JSON.parse(row.caps) as Caps & { contextTokens?: number | null }
  const servedWindow = typeof stored.contextTokens === 'number' ? stored.contextTokens : null
  const contextLimit = gooseContextLimit(servedWindow, jobContextTokens, promptBytes)
  return {
    BOTTEGA_MODEL_HOST_URL: row.base_url,
    OPENAI_BASE_URL: row.base_url,
    ...(row.harness === 'goose'
      ? {
          GOOSE_PROVIDER: 'openai',
          GOOSE_MODEL: row.model,
          GOOSE_TELEMETRY_ENABLED: 'false',
          ...(contextLimit === null ? {} : { GOOSE_CONTEXT_LIMIT: String(contextLimit) }),
          ...(writesRepo === false ? { GOOSE_MAX_TURNS: String(GOOSE_READING_MAX_TURNS) } : {}),
        }
      : {}),
  }
}

export function rowAgent(row: AgentRow): Agent {
  const stored = JSON.parse(row.caps) as Caps & { contextTokens?: number | null }
  const probeResult = row.probe_result ? JSON.parse(row.probe_result) : null
  const harnessBuiltin = BUILTIN_AGENTS[row.harness]
  const legacy = !HARNESSES.includes(row.harness as Harness)
  const adapter = harnessBuiltin
  const base: Agent = adapter
    ? { ...adapter }
    : {
        name: row.name,
        bin: row.harness,
        minimumCliVersion: '0.0.0',
        billing: row.billing,
        operatedBy: row.operated_by,
        model: row.model,
        caps: stored,
        defaultTransport: row.transport,
        stdin: false,
        maxPromptBytes: Number.POSITIVE_INFINITY,
        readsOut: false,
        timeoutMs: 20 * 60_000,
        contextTokens: stored.contextTokens ?? 0,
        outputCeilingStopReason: null,
        notes: `${legacy ? 'Legacy agent; historical evidence only.' : `${row.harness} ACP harness.`}`,
        argv() {
          throw new Error(`${row.name} has no CLI transport; use ACP`)
        },
      }
  return {
    ...base,
    name: row.name,
    harness: row.harness,
    backend: row.backend,
    baseUrl: row.base_url,
    apiKeySecret: row.api_key_secret,
    model: row.model,
    billing: row.billing,
    operatedBy: row.operated_by,
    caps: stored,
    defaultTransport: row.transport,
    acpSessionLoad: row.transport === 'acp',
    contextTokens: Object.hasOwn(stored, 'contextTokens')
      ? stored.contextTokens === null
        ? Number.POSITIVE_INFINITY
        : stored.contextTokens!
      : 0,
    enabled: Boolean(row.enabled),
    disabledReason: row.disabled_reason,
    probedAt: row.probed_at,
    probeResult,
    probePassed: probeResult
      ? typeof probeResult.ok === 'boolean'
        ? probeResult.ok
        : null
      : false,
    legacy,
    jobs: row.jobs ? JSON.parse(row.jobs) : null,
    preferredJobs: row.preferred_jobs ? JSON.parse(row.preferred_jobs) : [],
    maxConcurrent: row.max_concurrent,
    routeMetered: Boolean(row.route_metered),
    trainsOnInputs: Boolean(row.trains_on_inputs),
    ...(row.base_url
      ? {
          env: (
            jobContextTokens?: number | null,
            promptBytes?: number | null,
            writesRepo?: boolean | null,
          ) => ({
            ...(base.env?.() ?? {}),
            ...rowLaunchEnvironment(
              row,
              jobContextTokens ?? null,
              promptBytes ?? null,
              writesRepo ?? null,
            ),
          }),
        }
      : {}),
  }
}

const FALLBACK_AGENTS: Record<string, Agent> = {
  ...BUILTIN_AGENTS,
  ...Object.fromEntries(
    [
      {
        name: 'agy',
        harness: 'agy',
        backend: 'vendor',
        model: 'gemini-3.1-pro-high',
        base_url: null,
        transport: 'cli',
        billing: 'free',
        operated_by: 'vendor',
        enabled: 0,
        disabled_reason: 'no readsRepo; only two inline jobs and negligible evidence',
        probed_at: '2026-09-07T00:00:00.000Z',
        probe_result: '{"source":"migrated verified capabilities","legacy":true}',
        caps: '{"readsRepo":false,"mcp":false,"discoversMcpFromCwd":false,"schema":true,"writesRepo":false,"resumable":false,"contextTokens":null}',
      },
      {
        name: 'qwen36-qwencli',
        harness: 'qwen',
        backend: 'vllm',
        model: 'Qwen/Qwen3.6-35B-A3B',
        base_url: null,
        transport: 'cli',
        billing: 'none',
        operated_by: 'self',
        enabled: 0,
        disabled_reason: 'retired bespoke driver; replacement is qwen36-goose',
        probed_at: '2026-09-07T00:00:00.000Z',
        probe_result: '{"source":"migrated verified capabilities","legacy":true}',
        caps: '{"readsRepo":true,"mcp":true,"discoversMcpFromCwd":false,"schema":false,"writesRepo":false,"resumable":false,"contextTokens":131072}',
      },
    ].map((row) => [row.name, rowAgent(row as AgentRow)]),
  ),
}

export function agentRows(): AgentRow[] {
  if (!existsSync(DB_PATH)) throw new Error(`orchestrator database does not exist: ${DB_PATH}`)
  // Let the canonical opener diagnose a stranded WAL. SQLite cannot open this
  // shape read-only without its shared-memory sidecar, and db() carries the
  // actionable lifecycle refusal for it.
  if (existsSync(`${DB_PATH}-wal`) && !existsSync(`${DB_PATH}-shm`)) {
    return dbForAgents().query('SELECT * FROM agent ORDER BY name').all() as AgentRow[]
  }
  // Registry reads happen during jobs.ts import. Keep them genuinely read-only:
  // reporting commands such as review coverage-audit promise not to alter the
  // database bytes merely by importing the job/agent catalogues.
  const database = new Database(DB_PATH, { readonly: true })
  try {
    return database.query('SELECT * FROM agent ORDER BY name').all() as AgentRow[]
  } finally {
    database.close()
  }
}

let agentCache: Record<string, Agent> | null = null
function loadedAgents(): Record<string, Agent> {
  if (agentCache) return agentCache
  try {
    const rows = agentRows()
    const loaded = Object.fromEntries(rows.map((row) => [row.name, rowAgent(row)]))
    for (const [name, agent] of Object.entries(loaded)) assertResumableAgent(name, agent, false)
    agentCache = loaded
    return loaded
  } catch (error) {
    if (String((error as Error).message).includes('database does not exist')) return FALLBACK_AGENTS
    throw error
  }
}
/** Reload registry rows at a mutation or long-lived reporting boundary. */
export function refreshAgents(): void {
  agentCache = null
}
export const AGENTS: Record<string, Agent> = new Proxy(
  {},
  {
    get: (_target, property) => loadedAgents()[property as string],
    ownKeys: () => Reflect.ownKeys(loadedAgents()),
    has: (_target, property) => property in loadedAgents(),
    getOwnPropertyDescriptor: (_target, property) =>
      property in loadedAgents()
        ? { enumerable: true, configurable: true, value: loadedAgents()[property as string] }
        : undefined,
  },
)
export function requireAgent(name: string): Agent {
  const agent = AGENTS[name]
  if (agent) return agent
  const source = existsSync(DB_PATH)
    ? `store path ${JSON.stringify(DB_PATH)}`
    : 'the built-in fallback was used because the database file does not exist'
  throw new Error(
    `this process's agent registry lacks requested key ${JSON.stringify(name)}; ${source}; loaded keys ${JSON.stringify(Object.keys(AGENTS))}.`,
  )
}

export type AgentMutation = {
  harness?: Harness
  backend?: Backend
  model?: string
  baseUrl?: string | null
  apiKeySecret?: string | null
  transport?: 'cli' | 'acp'
  billing?: Agent['billing']
  contextTokens?: number
  enabled?: boolean
  reason?: string
  jobs?: string[] | null
  preferredJobs?: string[]
  maxConcurrent?: number | null
  routeMetered?: boolean
  trainsOnInputs?: boolean
}

function assertApiKeySecret(value: string | null | undefined): void {
  if (value !== undefined && value !== null && !value.trim())
    throw new Error('--api-key-secret must name a non-empty configuration key')
}

function assertAgentMutation(input: AgentMutation, adding: boolean): void {
  if (input.harness && !HARNESSES.includes(input.harness))
    throw new Error(`unknown harness "${input.harness}"`)
  if (input.backend && !BACKENDS.includes(input.backend))
    throw new Error(`unknown backend "${input.backend}"`)
  if (input.transport && !['cli', 'acp'].includes(input.transport))
    throw new Error(`unknown transport "${input.transport}"`)
  if (
    input.billing &&
    !['subscription', 'free', 'metered', 'none', 'unknown'].includes(input.billing)
  ) {
    throw new Error(`unknown billing "${input.billing}"`)
  }
  if (input.enabled === false && !input.reason?.trim()) {
    throw new Error('disabling an agent requires --reason')
  }
  assertApiKeySecret(input.apiKeySecret)
  if (input.enabled !== false && input.reason !== undefined) {
    throw new Error('--reason is only valid with --enabled false')
  }
  if (
    input.contextTokens !== undefined &&
    (!Number.isInteger(input.contextTokens) || input.contextTokens <= 0)
  ) {
    throw new Error('--context-tokens must be a positive integer')
  }
  for (const [flag, jobs] of [
    ['--jobs', input.jobs],
    ['--prefer', input.preferredJobs],
  ] as const) {
    if (
      jobs !== undefined &&
      jobs !== null &&
      (!Array.isArray(jobs) || jobs.some((job) => !job.trim()))
    ) {
      throw new Error(`${flag} must be any or a comma-separated list of jobs`)
    }
  }
  if (
    input.maxConcurrent !== undefined &&
    input.maxConcurrent !== null &&
    (!Number.isInteger(input.maxConcurrent) || input.maxConcurrent <= 0)
  ) {
    throw new Error('--max-concurrent must be a positive integer')
  }
  if (adding && (!input.harness || !input.backend || !input.model)) {
    throw new Error('agent add requires --harness, --backend, and --model')
  }
}

export function addAgent(name: string, input: AgentMutation): AgentRow {
  assertAgentMutation(input, true)
  const caps = {
    readsRepo: false,
    mcp: false,
    discoversMcpFromCwd: false,
    schema: false,
    replyFile: false,
    writesRepo: false,
    resumable: false,
    ...(input.contextTokens ? { contextTokens: input.contextTokens } : {}),
  }
  writableDb()
    .query(
      `INSERT INTO agent (record_id,name,harness,backend,model,base_url,api_key_secret,transport,caps,billing,operated_by,enabled,disabled_reason,jobs,preferred_jobs,max_concurrent,route_metered,trains_on_inputs)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      newRecordId(),
      name,
      input.harness!,
      input.backend!,
      input.model!,
      input.baseUrl ?? null,
      input.apiKeySecret ?? null,
      input.transport ?? 'acp',
      JSON.stringify(caps),
      input.billing ??
        (input.apiKeySecret ? 'metered' : input.backend === 'vendor' ? 'subscription' : 'none'),
      input.backend === 'vendor' ? 'vendor' : 'self',
      input.enabled === false ? 0 : 1,
      input.enabled === false ? input.reason!.trim() : null,
      input.jobs == null ? null : JSON.stringify(input.jobs),
      input.preferredJobs === undefined ? null : JSON.stringify(input.preferredJobs),
      input.maxConcurrent ?? null,
      input.routeMetered ? 1 : 0,
      input.trainsOnInputs ? 1 : 0,
    )
  refreshAgents()
  return agentRows().find((row) => row.name === name)!
}

function storedApiKeySecret(current: AgentRow, input: AgentMutation): string | null {
  return input.apiKeySecret === undefined ? current.api_key_secret : input.apiKeySecret
}

function agentIdentityChanged(current: AgentRow, input: AgentMutation): boolean {
  return (
    (input.harness !== undefined && input.harness !== current.harness) ||
    (input.backend !== undefined && input.backend !== current.backend) ||
    (input.model !== undefined && input.model !== current.model) ||
    (input.baseUrl !== undefined && input.baseUrl !== current.base_url) ||
    (input.apiKeySecret !== undefined && input.apiKeySecret !== current.api_key_secret)
  )
}

function agentEnabledFields(current: AgentRow, input: AgentMutation) {
  return {
    enabled: input.enabled === undefined ? current.enabled : input.enabled ? 1 : 0,
    reason:
      input.enabled === false
        ? input.reason!.trim()
        : input.enabled === true
          ? null
          : current.disabled_reason,
  }
}

function storedTrainsOnInputs(current: AgentRow, input: AgentMutation): number {
  if (input.trainsOnInputs === undefined) return current.trains_on_inputs
  return input.trainsOnInputs ? 1 : 0
}

export function setAgent(name: string, input: AgentMutation): AgentRow {
  assertAgentMutation(input, false)
  const current = agentRows().find((row) => row.name === name)
  if (!current) throw new Error(`unknown agent "${name}"`)
  let caps = JSON.parse(current.caps) as Record<string, unknown>
  const { enabled, reason } = agentEnabledFields(current, input)
  const identityChanged = agentIdentityChanged(current, input)
  let probedAt = current.probed_at
  let probeResult = current.probe_result
  if (identityChanged) {
    const previous = current.probe_result ? JSON.parse(current.probe_result) : null
    const attempts = Array.isArray(previous?.attempts) ? previous.attempts : []
    if (previous && !previous.pendingIdentity) {
      attempts.push({ harness: previous.harness ?? current.harness, result: previous })
    }
    const declaredContext =
      input.contextTokens ??
      (previous?.contextSource === 'declared' ? Number(caps.contextTokens) : undefined)
    caps = {
      readsRepo: false,
      mcp: false,
      discoversMcpFromCwd: false,
      schema: false,
      writesRepo: false,
      resumable: false,
      ...(declaredContext ? { contextTokens: declaredContext } : {}),
    }
    probedAt = null
    probeResult = JSON.stringify({
      ok: false,
      pendingIdentity: {
        harness: input.harness ?? current.harness,
        backend: input.backend ?? current.backend,
        model: input.model ?? current.model,
        baseUrl: input.baseUrl === undefined ? current.base_url : input.baseUrl,
        apiKeySecret: storedApiKeySecret(current, input),
      },
      attempts,
    })
  } else if (input.contextTokens !== undefined) {
    caps.contextTokens = input.contextTokens
  }
  if (!identityChanged && input.jobs !== undefined && current.probe_result) {
    const previous = JSON.parse(current.probe_result) as RegistrationProbeResult
    const currentJobs = current.jobs ? (JSON.parse(current.jobs) as string[]) : null
    const targetJobs = input.jobs ?? Object.keys(previous.jobs ?? {})
    const widened =
      currentJobs === null ? [] : targetJobs.filter((job) => !currentJobs.includes(job))
    const unestablished = widened.filter((job) => {
      const observations = previous.jobs?.[job]
      return !observations || Object.values(observations).some((value) => value !== true)
    })
    if (unestablished.length) {
      probedAt = null
      probeResult = JSON.stringify({ ...previous, ok: null, pendingCapabilities: unestablished })
    }
  }
  writableDb()
    .query(
      `UPDATE agent SET harness=?,backend=?,model=?,base_url=?,api_key_secret=?,transport=?,caps=?,billing=?,enabled=?,disabled_reason=?,probed_at=?,probe_result=?,jobs=?,preferred_jobs=?,max_concurrent=?,route_metered=?,trains_on_inputs=? WHERE name=?`,
    )
    .run(
      input.harness ?? current.harness,
      input.backend ?? current.backend,
      input.model ?? current.model,
      input.baseUrl === undefined ? current.base_url : input.baseUrl,
      storedApiKeySecret(current, input),
      input.transport ?? current.transport,
      JSON.stringify(caps),
      input.billing ?? current.billing,
      enabled,
      reason,
      probedAt,
      probeResult,
      input.jobs === undefined
        ? current.jobs
        : input.jobs === null
          ? null
          : JSON.stringify(input.jobs),
      input.preferredJobs === undefined
        ? current.preferred_jobs
        : JSON.stringify(input.preferredJobs),
      input.maxConcurrent === undefined ? current.max_concurrent : input.maxConcurrent,
      input.routeMetered === undefined ? current.route_metered : input.routeMetered ? 1 : 0,
      storedTrainsOnInputs(current, input),
      name,
    )
  refreshAgents()
  return agentRows().find((row) => row.name === name)!
}

export function removeAgent(name: string): void {
  const count = (
    dbForAgents().query('SELECT COUNT(*) n FROM run WHERE agent=?').get(name) as { n: number }
  ).n
  if (count) {
    throw new Error(
      `refusing to remove agent "${name}": ${count} run row${count === 1 ? '' : 's'} name it\n` +
        `disable it instead: ${PLATFORM_SLUG} agent set ${name} --enabled false --reason <reason>`,
    )
  }
  const result = writableDb().query('DELETE FROM agent WHERE name=?').run(name)
  if (!result.changes) throw new Error(`unknown agent "${name}"`)
  refreshAgents()
}

export type RegistrationProbeResult = {
  harness: string
  ok: boolean | null
  reply: { ok: boolean; output: string }
  tool: { ok: boolean | null; output: string; toolEvents: number; statuses: string[] }
  schema: { ok: boolean | null; output: string }
  file?: { ok: boolean | null; output: string }
  mcp?: { verifiable: boolean | null; output: string }
  writing?: { ok: boolean | null; output: string }
  resuming?: { ok: boolean | null; output: string }
  jobs?: Record<
    string,
    {
      reply?: boolean
      tool?: boolean | null
      schema?: boolean | null
      mcp?: boolean | null
      writing?: boolean | null
      resuming?: boolean | null
    }
  >
  contextTokens: number | null
  contextSource: 'harness' | 'declared' | null
  budget?: OpenRouterRecordedBudget
  billingHold?: boolean
  refusal?: string
  attempts?: { harness: string; result: unknown }[]
}
