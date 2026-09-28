import { type ChildProcess, spawn } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'
import { terminateProcessGroup } from '../idle-kill.ts'
import type { SandboxRuntimeConfig } from '../sandbox/sandbox.ts'
import { sandboxLaunchArgv } from '../sandbox/sandbox.ts'
import {
  type AcpTrace,
  createAcpTrace,
  installAcpChildTrace,
  installAcpConnectionTrace,
  installAcpStreamTrace,
  traceAcpHandshake,
} from './acp-trace.ts'
import {
  ACP_PILOT_TASK,
  type AgentTransport,
  confineFsPath,
  decideAcpPermission,
  type NormalizedEvent,
  outcomeFromTransport,
  registerTransport,
  resolveCodexAcpBin,
  stopErrorMessage,
  type TransportHandle,
  TransportOperationTimeout,
  type TransportResult,
  type TransportStartOpts,
  withTransportDeadline,
} from './transport.ts'

type AcpUpdate = {
  sessionUpdate: string
  toolCallId?: string
  content?: { type?: string; text?: string } | unknown[]
  title?: string
  status?: string
  kind?: string
  used?: number
  cost?: { amount?: number; currency?: string } | null
  locations?: Array<{ path?: string }>
  rawInput?: unknown
  rawOutput?: unknown
}
type AcpTurnInput = {
  sessionId?: string | null
  updates: unknown[]
  stopReason?: string | null
  elicitation?: { message: string } | null
  error?: string | null
  timedOut?: boolean
  permissionEvents?: Extract<NormalizedEvent, { kind: 'permission' }>[]
  usage?: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    costUsd?: number
  } | null
}
type GrokSessionResponse = {
  models?: { currentModelId?: unknown; availableModels?: unknown }
  _meta?: Record<string, unknown> | null
}

const ACP_HANDSHAKE_TIMEOUT_MS = 60_000
type AcpHandshakeStage = 'initialize' | 'session/load' | 'session/new'

/** Bound a startup request before callers have a transport handle or wall timer. */
export async function awaitAcpHandshake<T>(opts: {
  request: Promise<T>
  stage: AcpHandshakeStage
  harness: string
  pid: number | null
  terminate: () => Promise<unknown>
  schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
  unschedule?: (timer: ReturnType<typeof setTimeout>) => void
}): Promise<T> {
  try {
    return await withTransportDeadline({
      operation: opts.request,
      operationName: `ACP handshake ${opts.stage}`,
      timeoutMs: ACP_HANDSHAKE_TIMEOUT_MS,
      onTimeout: opts.terminate,
      schedule: opts.schedule,
      unschedule: opts.unschedule,
    })
  } catch (error) {
    if (!(error instanceof TransportOperationTimeout)) throw error
    throw new Error(
      `ACP handshake refusal: ${opts.stage} timed out after ${ACP_HANDSHAKE_TIMEOUT_MS}ms ` +
        `for ${opts.harness} harness (pid ${opts.pid ?? 'unknown'}); inspect the harness ` +
        `startup logs, fix the stalled stage, and rerun the command`,
    )
  }
}

/** Persist the text observed so far without waiting for a terminal prompt response. */
export function persistAcpUpdates(
  outPath: string,
  sessionId: string | null,
  updates: unknown[],
): void {
  writeFileSync(outPath, normalizeAcpTurn({ sessionId, updates }).output)
}

/** Grok 1.0.13 accepts its ACP model as an extension on session/new. */
export function grokSessionMeta(model: string | undefined): Record<string, unknown> | undefined {
  return model ? { modelId: model } : undefined
}

/** Read back the model Grok says the session actually uses. */
export function grokEffectiveModel(
  response: GrokSessionResponse,
  requested: string | undefined,
  explicit: boolean,
): string | null {
  const current = response.models?.currentModelId
  const effective = typeof current === 'string' && current.trim() ? current : null
  if (explicit && (!effective || effective !== requested)) {
    throw new Error(
      `${ACP_PILOT_TASK} Grok ACP model refusal: requested ${JSON.stringify(requested)}; ` +
        `session reported ${effective ? JSON.stringify(effective) : 'no effective model'}`,
    )
  }
  return effective
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asUpdate(value: unknown): AcpUpdate | null {
  if (!isRecord(value) || typeof value.sessionUpdate !== 'string') return null
  return value as AcpUpdate
}

function textOf(content: AcpUpdate['content']): string {
  if (
    content &&
    !Array.isArray(content) &&
    content.type === 'text' &&
    typeof content.text === 'string'
  ) {
    return content.text
  }
  return ''
}

function toolCallTarget(update: AcpUpdate): string | undefined {
  if (Array.isArray(update.locations)) {
    for (const location of update.locations) {
      if (typeof location?.path === 'string' && location.path) return location.path
    }
  }
  if (
    isRecord(update.rawInput) &&
    typeof update.rawInput.path === 'string' &&
    update.rawInput.path
  ) {
    return update.rawInput.path
  }
  return undefined
}

function toolCallResult(update: AcpUpdate): string | undefined {
  if (typeof update.rawOutput === 'string' && update.rawOutput) return update.rawOutput
  if (!Array.isArray(update.content)) return undefined
  const parts: string[] = []
  for (const item of update.content) {
    if (!isRecord(item)) continue
    if (
      item.type === 'content' &&
      isRecord(item.content) &&
      item.content.type === 'text' &&
      typeof item.content.text === 'string'
    ) {
      parts.push(item.content.text)
    } else if (item.type === 'text' && typeof item.text === 'string') {
      parts.push(item.text)
    }
  }
  return parts.length ? parts.join('') : undefined
}

/**
 * Fold ACP session updates into orch's existing run facts: text, tokens,
 * session id, stop reason, and a terminal outcome. The store never sees ACP.
 *
 * A non-end_turn stop is a failure even when some agent text already arrived,
 * except elicitation which is asking.
 */
export function normalizeAcpTurn(input: AcpTurnInput): TransportResult {
  const events: NormalizedEvent[] = []
  const chunks: string[] = []
  const reportedInput = typeof input.usage?.inputTokens === 'number'
  const reportedOutput = typeof input.usage?.outputTokens === 'number'
  const reportedTotal = typeof input.usage?.totalTokens === 'number'
  let tokens: number | null = null
  if (reportedInput || reportedOutput) {
    tokens = (input.usage!.inputTokens ?? 0) + (input.usage!.outputTokens ?? 0)
  } else if (reportedTotal) {
    tokens = input.usage!.totalTokens!
  }
  let costUsd: number | null = null
  if (typeof input.usage?.costUsd === 'number') costUsd = input.usage.costUsd
  const sessionId = input.sessionId ?? null
  if (sessionId) events.push({ kind: 'session', sessionId })
  for (const event of input.permissionEvents ?? []) events.push(event)

  // ACP splits one tool call across a `tool_call` (kind, title, locations,
  // input) and later `tool_call_update`s (status, output). Goose sends the
  // updates with nothing but the status, so an event built per update never
  // carries both "completed" and the target, and the registration probe's
  // readsRepo gate could not be satisfied by a harness that had read the file
  // (2026-09-07, qwen36-goose: three events, statuses unknown, unknown, completed,
  // the sentinel in the final reply). Updates fold into the call they name.
  const toolCalls = new Map<string, Extract<NormalizedEvent, { kind: 'tool' }>>()
  for (const raw of input.updates) {
    const update = asUpdate(isRecord(raw) && 'update' in raw ? raw.update : raw)
    if (!update) continue
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = textOf(update.content)
        if (text) {
          chunks.push(text)
          events.push({ kind: 'text', text })
        }
        break
      }
      case 'tool_call':
      case 'tool_call_update': {
        const known = update.toolCallId ? toolCalls.get(update.toolCallId) : undefined
        if (update.sessionUpdate === 'tool_call_update' && known) {
          if (update.status) known.status = update.status
          if (update.title) known.title = update.title
          if (update.kind) known.toolKind = update.kind
          const target = toolCallTarget(update)
          if (target) known.target = target
          const result = toolCallResult(update)
          if (result) known.result = result
          const paths = Array.isArray(update.locations)
            ? update.locations.flatMap((location) =>
                typeof location?.path === 'string' && location.path
                  ? [{ path: location.path }]
                  : [],
              )
            : []
          if (paths.length) known.locations = [...(known.locations ?? []), ...paths]
          break
        }
        const locations = Array.isArray(update.locations)
          ? update.locations.flatMap((location) =>
              typeof location?.path === 'string' && location.path ? [{ path: location.path }] : [],
            )
          : undefined
        const event: Extract<NormalizedEvent, { kind: 'tool' }> = {
          kind: 'tool',
          title: update.title ?? update.sessionUpdate,
          status: update.status,
          toolKind: update.kind,
          target: toolCallTarget(update),
          result: toolCallResult(update),
          ...(locations?.length ? { locations } : {}),
        }
        events.push(event)
        if (update.toolCallId) toolCalls.set(update.toolCallId, event)
        break
      }
      case 'usage_update':
        if (typeof update.used === 'number') {
          tokens = update.used
          const amount = update.cost?.amount
          costUsd = update.cost?.currency === 'USD' && typeof amount === 'number' ? amount : null
          events.push({ kind: 'usage', tokens, costUsd })
        }
        break
      default:
        break
    }
  }

  if (input.elicitation) {
    events.push({ kind: 'elicitation', message: input.elicitation.message })
  }

  let stopReason = input.stopReason ?? null
  if (input.timedOut) stopReason = 'timeout'
  if (input.error) events.push({ kind: 'error', error: input.error })
  if (stopReason) events.push({ kind: 'stop', reason: stopReason })

  const output = chunks.join('')
  const asking = Boolean(input.elicitation)
  let error: string | null = input.error ?? null
  if (!error && !asking && stopReason && stopReason !== 'end_turn') {
    error = stopErrorMessage(stopReason)
  }
  if (!error && !asking && !output.trim() && !stopReason) {
    error = 'ACP turn produced no agent message'
  }

  const raw = input.updates.map((update) => JSON.stringify(update)).join('\n')
  const folded = outcomeFromTransport({
    asking,
    error,
    exitCode: 0,
    output,
    stopReason,
  })
  let exitCode = 0
  if (folded.status === 'failed') {
    exitCode = stopReason === 'timeout' || stopReason === 'cancelled' ? 143 : 1
  }

  return {
    output,
    stdout: raw,
    stderr: '',
    raw,
    parsed: { text: output, tokens, costUsd, stopReason, error: error ?? undefined },
    tokens,
    costUsd,
    sessionId,
    stopReason,
    error,
    exitCode,
    pid: null,
    events,
    asking,
    failureKind: folded.failureKind,
    status: folded.status,
    questions:
      asking && input.elicitation
        ? [
            {
              question: input.elicitation.message,
              why: 'ACP elicitation/create mapped to the orch ask channel',
            },
          ]
        : [],
  }
}

function webStream(
  child: ChildProcess,
  trace: AcpTrace | null,
): ReturnType<typeof acp.ndJsonStream> {
  if (!child.stdin || !child.stdout) throw new Error('ACP agent stdio is not a pipe')
  if (trace) installAcpStreamTrace(trace, child.stdin, child.stdout)
  const input = Writable.toWeb(child.stdin)
  const output = Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>
  return acp.ndJsonStream(input, output)
}

export function acpHarnessArgv(harness: string, leaderSocket?: string | null): string[] {
  if (harness === 'grok') return ['agent', 'stdio', '--leader-socket', leaderSocket!]
  if (harness === 'opencode' || harness === 'goose') return ['acp']
  return []
}

function readTextFile(path: string, line?: number | null, limit?: number | null): string {
  const body = readFileSync(path, 'utf8')
  if (line == null && limit == null) return body
  const lines = body.split('\n')
  const start = Math.max((line ?? 1) - 1, 0)
  const end = limit == null ? lines.length : start + limit
  return lines.slice(start, end).join('\n')
}

/** Add only the per-run Grok leader socket to the profile persisted for srt. */
export function acpSandboxProfile(
  profile: SandboxRuntimeConfig,
  leaderSocket: string | null,
): SandboxRuntimeConfig {
  if (!leaderSocket) return profile
  return {
    ...profile,
    network: {
      ...profile.network,
      allowUnixSockets: [...profile.network.allowUnixSockets, leaderSocket],
    },
  }
}

/** Grok must create its leader inside the directory the run may write. */
export function acpLeaderSocketPath(outPath: string, runtimeDir?: string): string {
  return runtimeDir ? join(runtimeDir, 'grok-leader.sock') : `${outPath}.leader.sock`
}

function acpEnvironment(opts: TransportStartOpts): Record<string, string> {
  const env: Record<string, string> = {
    ...opts.env,
    ...opts.recipeEnvironment,
    NO_BROWSER: '1',
    INITIAL_AGENT_MODE: 'read-only',
  }
  if (opts.model) env.CODEX_CONFIG = JSON.stringify({ model: opts.model })
  if (opts.agent.harness === 'opencode' && opts.agent.baseUrl && opts.model) {
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      model: `orch-local/${opts.model}`,
      provider: {
        'orch-local': {
          npm: '@ai-sdk/openai-compatible',
          name: 'orch local backend',
          options: { baseURL: opts.agent.baseUrl, apiKey: 'local' },
          models: { [opts.model]: { name: opts.model } },
        },
      },
    })
  }
  if (opts.agent.harness === 'goose') {
    const stateDir = opts.srt?.runtimeDir ?? dirname(opts.outPath)
    env.XDG_STATE_HOME = stateDir
    env.XDG_DATA_HOME = stateDir
    env.XDG_CONFIG_HOME = stateDir
  }
  return env
}

function acpLaunchArgv(
  opts: TransportStartOpts,
  profile: SandboxRuntimeConfig | null,
  bin: string,
  agentArgv: string[],
): Promise<string[]> | string[] {
  if (!profile || !opts.srt) return [bin, ...agentArgv]
  return sandboxLaunchArgv(profile, bin, agentArgv)
}

function acpUsage(response: { _meta?: unknown; usage?: unknown }): AcpTurnInput['usage'] {
  const meta = isRecord(response._meta) ? response._meta : null
  const nested = meta && isRecord(meta.usage) ? meta.usage : null
  const direct = isRecord(response.usage) ? response.usage : null
  const usage = (nested ?? direct) as Record<string, unknown> | null
  const inputTokens = usage && typeof usage.inputTokens === 'number' ? usage.inputTokens : undefined
  const outputTokens =
    usage && typeof usage.outputTokens === 'number' ? usage.outputTokens : undefined
  const totalTokens = usage && typeof usage.totalTokens === 'number' ? usage.totalTokens : undefined
  const costTicks = usage && typeof usage.costUsdTicks === 'number' ? usage.costUsdTicks : undefined
  const costUsd = costTicks === undefined ? undefined : costTicks / 1_000_000_000
  return inputTokens !== undefined ||
    outputTokens !== undefined ||
    totalTokens !== undefined ||
    costUsd !== undefined
    ? { inputTokens, outputTokens, totalTokens, costUsd }
    : null
}

async function openAcp(opts: TransportStartOpts): Promise<TransportHandle> {
  const grok = opts.agent.name === 'grok'
  const genericHarness = opts.agent.harness === 'opencode' || opts.agent.harness === 'goose'
  const bin = opts.bin ?? (grok || genericHarness ? opts.agent.bin : resolveCodexAcpBin())
  const leaderSocket = grok ? acpLeaderSocketPath(opts.outPath, opts.srt?.runtimeDir) : null
  const agentArgv = acpHarnessArgv(opts.agent.harness ?? opts.agent.name, leaderSocket)
  const profile = opts.srt ? acpSandboxProfile(opts.srt.profile, leaderSocket) : null
  const launch = await acpLaunchArgv(opts, profile, bin, agentArgv)
  const child = spawn(launch[0]!, launch.slice(1), {
    cwd: opts.cwd,
    env: acpEnvironment(opts),
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  })
  const trace = createAcpTrace(
    opts.env.ORCH_ACP_TRACE,
    opts.env.ORCH_RUN_ID ?? 'unknown-run',
    child.pid ?? 0,
    bin,
    agentArgv,
    opts.cwd,
    profile !== null,
  )
  installAcpChildTrace(trace, child)

  const stderrChunks: Buffer[] = []
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrChunks.push(chunk)
  })

  const updates: unknown[] = []
  const liveEvents: NormalizedEvent[] = []
  const permissionEvents: Extract<NormalizedEvent, { kind: 'permission' }>[] = []
  const eventWaiters: Array<(event: NormalizedEvent | null) => void> = []
  let elicitation: { message: string } | null = null
  let elicitationFallback: string | null = null
  let closed = false
  let prompted = false
  let sessionId: string | null = opts.session ?? null
  let effectiveModel: string | null = null
  let connection: acp.ClientConnection | null = null
  let ctx: acp.ClientContext | null = null

  const pushEvent = (event: NormalizedEvent) => {
    liveEvents.push(event)
    const wait = eventWaiters.shift()
    if (wait) wait(event)
  }

  const app = acp
    .client({ name: 'orch' })
    .onRequest(acp.methods.client.session.requestPermission, (req) => {
      // orch replies allow/reject here; the sandboxed child does not. Read-class
      // tools may run; edit/write/execute are rejected. Gap: the architect never
      // sees the prompt — the decision is the pilot policy, not a ruling.
      const title = req.params.toolCall.title ?? 'tool'
      const toolKind = req.params.toolCall.kind ?? undefined
      const optionKinds = req.params.options.map((option) => option.kind)
      const decided = decideAcpPermission(toolKind, req.params.options)
      const event: Extract<NormalizedEvent, { kind: 'permission' }> = {
        kind: 'permission',
        title,
        optionKinds,
        toolKind,
        decision: decided.decision,
      }
      permissionEvents.push(event)
      pushEvent(event)
      return { outcome: decided.outcome }
    })
    .onRequest(acp.methods.client.elicitation.create, async (req) => {
      elicitation = { message: req.params.message }
      pushEvent({ kind: 'elicitation', message: req.params.message })
      if (req.params.mode === 'form') {
        const requested = isRecord(req.params.requestedSchema) ? req.params.requestedSchema : {}
        const properties = isRecord(requested.properties) ? requested.properties : {}
        const fields = Object.entries(properties)
        const stringFields = fields.filter(([, schema]) => {
          if (!isRecord(schema)) return false
          return (
            schema.type === 'string' ||
            (Array.isArray(schema.type) && schema.type.includes('string'))
          )
        })
        if (fields.length === 1 && stringFields.length === 1) {
          const runId = Number(opts.env.ORCH_RUN_ID ?? 0)
          if (runId) {
            const { ask } = await import('../ask/ask.ts')
            const { db } = await import('../database/db.ts')
            db().query("UPDATE run SET status='asking' WHERE id=? AND status='running'").run(runId)
            const answer = await ask({
              runId,
              question: req.params.message,
              why: 'ACP form elicitation delivered through orch answer',
            })
            if (answer.answered) {
              db()
                .query("UPDATE run SET status='running' WHERE id=? AND status='asking'")
                .run(runId)
              elicitation = null
              return {
                action: 'accept' as const,
                content: { [stringFields[0]![0]]: answer.answer },
              }
            }
            elicitationFallback =
              'ACP elicitation received no ruling before the ask-channel timeout'
          } else {
            elicitationFallback = 'ACP elicitation had no authenticated orch run identity'
          }
        } else {
          elicitationFallback = 'ACP elicitation schema was not exactly one string-compatible field'
        }
      } else {
        elicitationFallback = `ACP elicitation mode ${req.params.mode} is not a one-field form`
      }
      return { action: 'cancel' as const }
    })
    .onRequest(acp.methods.client.fs.readTextFile, (req) => {
      // The orch process, not the sandboxed child, serves this read. Confine
      // to the run worktree by realpath prefix; anything outside is refused.
      const confined = confineFsPath(req.params.path, opts.cwd)
      const content = readTextFile(confined, req.params.line, req.params.limit)
      return { content }
    })
    .onRequest(acp.methods.client.fs.writeTextFile, (req) => {
      // ACP has no result object. The one write it receives is the universal
      // reply carrier, confined to the run's artifact scratch directory.
      const scratch = opts.env.ORCH_SCRATCH
      if (!scratch) throw new Error('ACP fs.writeTextFile refused: ORCH_SCRATCH is not set')
      const confined = confineFsPath(req.params.path, scratch, 'writeTextFile')
      writeFileSync(confined, req.params.content)
      return {}
    })
    .onNotification(acp.methods.client.session.update, (req) => {
      // orch records the update as a run event; the store never holds ACP.
      updates.push(req.params)
      persistAcpUpdates(opts.outPath, sessionId, updates)
      const folded = normalizeAcpTurn({ sessionId, updates: [req.params] })
      for (const event of folded.events) {
        if (event.kind === 'session' || event.kind === 'stop') continue
        pushEvent(event)
      }
    })

  const stream = webStream(child, trace)
  connection = app.connect(stream)
  installAcpConnectionTrace(trace, connection.closed)
  ctx = connection.agent

  try {
    const handshake = <T>(request: Promise<T>, stage: AcpHandshakeStage) =>
      traceAcpHandshake(trace, stage, () =>
        awaitAcpHandshake({
          request,
          stage,
          harness: opts.agent.harness ?? opts.agent.name,
          pid: child.pid ?? null,
          terminate: () => terminateProcessGroup(child.pid ?? 0, { direct: child }),
        }),
      )
    await handshake(
      ctx.request(acp.methods.agent.initialize, {
        // ACP has no result object, so the reply file is the one advertised write.
        // Gap: usage_update.used is session context, not CLI input+output.
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          elicitation: { form: {} },
        },
        clientInfo: { name: 'orch', version: '0.1.0' },
      }),
      'initialize',
    )
    // The ruling channel is transport infrastructure, not a project MCP opt-in.
    // codex-acp needs it on session/new. Grok loads the per-run config prepared
    // in GROK_HOME; passing the same stdio server here makes 1.0.13 reject
    // session/new with "Path not found."
    const mcpServers: acp.McpServer[] =
      !grok && opts.env.ORCH_RUN_ID && opts.env.ORCH_RUN_TOKEN
        ? [
            {
              name: 'orch-ask',
              command: bottegaEntryArgv('ask-server')[0]!,
              args: bottegaEntryArgv('ask-server').slice(1),
              env: ['ORCH_ASK_URL', 'ORCH_RUN_ID', 'ORCH_RUN_TOKEN', 'ORCH_DB'].flatMap((name) =>
                opts.env[name] ? [{ name, value: opts.env[name]! }] : [],
              ),
            },
          ]
        : []
    if (opts.session) {
      const loaded = await handshake(
        ctx.request(acp.methods.agent.session.load, {
          // orch resumes the vendor conversation; the prompt is the ruling.
          cwd: opts.cwd,
          sessionId: opts.session,
          mcpServers,
        }),
        'session/load',
      )
      sessionId = opts.session
      if (grok) {
        effectiveModel = grokEffectiveModel(
          loaded as GrokSessionResponse,
          opts.model,
          Boolean(opts.modelExplicit),
        )
      }
    } else {
      const created = await handshake(
        ctx.request(acp.methods.agent.session.new, {
          // orch opens a read-only session with its per-run ruling channel.
          cwd: opts.cwd,
          mcpServers,
          ...(grok ? { _meta: grokSessionMeta(opts.model) } : {}),
        }),
        'session/new',
      )
      sessionId = created.sessionId
      if (grok) {
        effectiveModel = grokEffectiveModel(
          created as GrokSessionResponse,
          opts.model,
          Boolean(opts.modelExplicit),
        )
      }
    }
    if (sessionId) pushEvent({ kind: 'session', sessionId })
  } catch (error) {
    closed = true
    persistAcpUpdates(opts.outPath, sessionId, updates)
    try {
      await terminateProcessGroup(child.pid ?? 0, { direct: child })
    } catch {
      /* already gone */
    }
    if (leaderSocket) rmSync(leaderSocket, { force: true })
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim()
    throw new Error([String((error as Error)?.message ?? error), stderr].filter(Boolean).join('\n'))
  }

  let collectPromise: Promise<TransportResult> | null = null
  let cancelled = false
  let terminalUsage: AcpTurnInput['usage'] = null

  const finishEvents = () => {
    for (const wait of eventWaiters) wait(null)
    eventWaiters.length = 0
  }

  const handle: TransportHandle = {
    pid: child.pid ?? null,
    effectiveModel,
    kill(_sig) {
      void terminateProcessGroup(child.pid ?? 0, { direct: child })
    },
    async prompt(text) {
      if (!ctx || !sessionId) throw new Error('ACP session is not open')
      if (prompted) return
      prompted = true
      const blocks: acp.ContentBlock[] = [{ type: 'text', text }]
      if (opts.schemaPath) {
        try {
          const schema = readFileSync(opts.schemaPath, 'utf8')
          blocks.push({
            type: 'text',
            text: `\nRespond with JSON matching this schema and nothing else:\n${schema}`,
          })
        } catch {
          /* schema is best-effort on the wire; run.ts validates */
        }
      }
      const promptWork = ctx.request(acp.methods.agent.session.prompt, {
        // orch sends the bound prompt as text blocks; schema is also inlined.
        sessionId,
        prompt: blocks,
      })
      collectPromise = (async () => {
        let stopReason: string | null = null
        let error: string | null = null
        try {
          const response = await promptWork
          stopReason = response.stopReason
          terminalUsage = acpUsage(response)
        } catch (cause) {
          error = String((cause as Error)?.message ?? cause)
        }
        let result: ReturnType<typeof normalizeAcpTurn>
        try {
          const stderr = Buffer.concat(stderrChunks).toString('utf8')
          result = normalizeAcpTurn({
            sessionId,
            updates,
            stopReason,
            elicitation,
            error,
            usage: terminalUsage,
            timedOut: cancelled,
            permissionEvents,
          })
          result.stderr = elicitationFallback
            ? [stderr, elicitationFallback].filter(Boolean).join('\n')
            : stderr
          result.pid = child.pid ?? null
          result.effectiveModel = effectiveModel
          writeFileSync(opts.outPath, result.output)
          if (result.stopReason) pushEvent({ kind: 'stop', reason: result.stopReason })
        } finally {
          // Waiters on events() must wake on every exit path (review 349).
          closed = true
          finishEvents()
        }
        try {
          connection?.close()
        } catch {
          /* already closed */
        }
        // Both paid adapters are long-lived stdio servers. A completed prompt is
        // the end of this orch run, so do not leave the adapter (or Grok's
        // per-run leader) alive after its result has been collected.
        void terminateProcessGroup(child.pid ?? 0, { direct: child })
        if (leaderSocket) rmSync(leaderSocket, { force: true })
        return result
      })()
    },
    async *events() {
      for (const event of liveEvents) yield event
      while (!closed) {
        const next = await new Promise<NormalizedEvent | null>((resolve) => {
          eventWaiters.push(resolve)
        })
        if (!next) break
        yield next
      }
    },
    async cancel() {
      // orch tells the agent to stop; harness cancel is a timeout, matching run.ts.
      cancelled = true
      if (ctx && sessionId) {
        try {
          await ctx.notify(acp.methods.agent.session.cancel, { sessionId })
        } catch {
          /* agent may already be gone */
        }
      }
      void terminateProcessGroup(child.pid ?? 0, { direct: child })
      if (leaderSocket) rmSync(leaderSocket, { force: true })
    },
    async collect() {
      if (!prompted) await handle.prompt(opts.prompt)
      if (!collectPromise) throw new Error('ACP collect called before prompt')
      return collectPromise
    },
  }
  return handle
}

const acpTransport: AgentTransport = {
  name: 'acp',
  canInjectMidTurn: false,
  start(opts) {
    return openAcp(opts)
  },
  prompt(handle, text) {
    return handle.prompt(text)
  },
  events(handle) {
    return handle.events()
  },
  cancel(handle) {
    return handle.cancel()
  },
  resume(opts) {
    return openAcp({ ...opts, resume: true })
  },
}
export function registerAcpTransport(): void {
  registerTransport('acp', () => acpTransport)
}
registerAcpTransport()
