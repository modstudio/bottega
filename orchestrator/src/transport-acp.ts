import { spawn, type ChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as acp from '@agentclientprotocol/sdk'
import { srtLaunchArgv } from './sandbox.ts'
import type { SandboxRuntimeConfig } from './sandbox.ts'
import {
  confineFsPath, decideAcpPermission, outcomeFromTransport, resolveCodexAcpBin, stopErrorMessage,
  type AgentTransport, type NormalizedEvent, type TransportHandle, type TransportResult,
  type TransportStartOpts,
} from './transport.ts'

type AcpUpdate = {
  sessionUpdate: string
  content?: { type?: string; text?: string }
  title?: string
  status?: string
  kind?: string
  used?: number
  cost?: { amount?: number; currency?: string } | null
}

type AcpTurnInput = {
  sessionId?: string | null
  updates: unknown[]
  stopReason?: string | null
  elicitation?: { message: string } | null
  error?: string | null
  timedOut?: boolean
  permissionEvents?: Extract<NormalizedEvent, { kind: 'permission' }>[]
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; costUsd?: number } | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asUpdate(value: unknown): AcpUpdate | null {
  if (!isRecord(value) || typeof value.sessionUpdate !== 'string') return null
  return value as AcpUpdate
}

function textOf(content: AcpUpdate['content']): string {
  if (content?.type === 'text' && typeof content.text === 'string') return content.text
  return ''
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
  let tokens: number | null = input.usage
    ? (input.usage.inputTokens ?? 0) + (input.usage.outputTokens ?? 0)
    : null
  if (input.usage?.totalTokens !== undefined &&
      input.usage.inputTokens === undefined && input.usage.outputTokens === undefined) {
    tokens = input.usage.totalTokens
  }
  let costUsd: number | null = null
  if (typeof input.usage?.costUsd === 'number') costUsd = input.usage.costUsd
  let sessionId = input.sessionId ?? null
  if (sessionId) events.push({ kind: 'session', sessionId })
  for (const event of input.permissionEvents ?? []) events.push(event)

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
      case 'tool_call_update':
        events.push({
          kind: 'tool',
          title: update.title ?? update.sessionUpdate,
          status: update.status,
          toolKind: update.kind,
        })
        break
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
    asking, error, exitCode: 0, output, stopReason,
  })
  let exitCode = 0
  if (folded.status === 'failed') {
    exitCode = stopReason === 'timeout' || stopReason === 'cancelled' ? 143 : 1
  }

  return {
    output, stdout: raw, stderr: '', raw,
    parsed: { text: output, tokens, costUsd, stopReason, error: error ?? undefined },
    tokens, costUsd, sessionId, stopReason, error,
    exitCode, pid: null, events, asking,
    failureKind: folded.failureKind, status: folded.status,
    questions: asking && input.elicitation
      ? [{
          question: input.elicitation.message,
          why: 'ACP elicitation/create mapped to the orch ask channel',
        }]
      : [],
  }
}

export function acpOutcome(result: TransportResult): 'ok' | 'asking' | 'failed' {
  return result.status
}

function webStream(child: ChildProcess): ReturnType<typeof acp.ndJsonStream> {
  if (!child.stdin || !child.stdout) throw new Error('ACP agent stdio is not a pipe')
  const input = Writable.toWeb(child.stdin)
  const output = Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>
  return acp.ndJsonStream(input, output)
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
  profile: SandboxRuntimeConfig, leaderSocket: string | null,
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
export function acpLeaderSocketPath(outPath: string, settingsPath?: string): string {
  return settingsPath
    ? join(dirname(settingsPath), 'grok-leader.sock')
    : `${outPath}.leader.sock`
}

async function openAcp(opts: TransportStartOpts): Promise<TransportHandle> {
  const grok = opts.agent.name === 'grok'
  const bin = opts.bin ?? (grok ? opts.agent.bin : resolveCodexAcpBin())
  const leaderSocket = grok ? acpLeaderSocketPath(opts.outPath, opts.srt?.settingsPath) : null
  const agentArgv = grok
    ? ['agent', 'stdio', '--leader-socket', leaderSocket!]
    : []
  const profile = opts.srt ? acpSandboxProfile(opts.srt.profile, leaderSocket) : null
  const launch = profile && opts.srt
    ? srtLaunchArgv(profile, opts.srt.settingsPath, bin, agentArgv)
    : [bin, ...agentArgv]
  const child = spawn(launch[0]!, launch.slice(1), {
    cwd: opts.cwd,
    env: {
      ...opts.env,
      NO_BROWSER: '1',
      INITIAL_AGENT_MODE: 'read-only',
      ...(opts.model ? { CODEX_CONFIG: JSON.stringify({ model: opts.model }) } : {}),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const stderrChunks: Buffer[] = []
  child.stderr?.on('data', (chunk: Buffer) => { stderrChunks.push(chunk) })

  const updates: unknown[] = []
  const liveEvents: NormalizedEvent[] = []
  const permissionEvents: Extract<NormalizedEvent, { kind: 'permission' }>[] = []
  const eventWaiters: Array<(event: NormalizedEvent | null) => void> = []
  let elicitation: { message: string } | null = null
  let elicitationFallback: string | null = null
  let closed = false
  let prompted = false
  let sessionId: string | null = opts.session ?? null
  let connection: acp.ClientConnection | null = null
  let ctx: acp.ClientContext | null = null

  const pushEvent = (event: NormalizedEvent) => {
    liveEvents.push(event)
    const wait = eventWaiters.shift()
    if (wait) wait(event)
  }

  const app = acp.client({ name: 'orch' })
    .onRequest(acp.methods.client.session.requestPermission, (req) => {
      // orch replies allow/reject here; the sandboxed child does not. Read-class
      // tools may run; edit/write/execute are rejected. Gap: the architect never
      // sees the prompt — the decision is the pilot policy, not a ruling.
      const title = req.params.toolCall.title ?? 'tool'
      const toolKind = req.params.toolCall.kind ?? undefined
      const optionKinds = req.params.options.map((option) => option.kind)
      const decided = decideAcpPermission(toolKind, req.params.options)
      const event: Extract<NormalizedEvent, { kind: 'permission' }> = {
        kind: 'permission', title, optionKinds, toolKind, decision: decided.decision,
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
          return schema.type === 'string' ||
            (Array.isArray(schema.type) && schema.type.includes('string'))
        })
        if (fields.length === 1 && stringFields.length === 1) {
          const runId = Number(opts.env.ORCH_RUN_ID ?? 0)
          if (runId) {
            const { ask } = await import('./ask.ts')
            const { db } = await import('./db.ts')
            db().query("UPDATE run SET status='asking' WHERE id=? AND status='running'").run(runId)
            const answer = await ask({
              runId,
              question: req.params.message,
              why: 'ACP form elicitation delivered through orch answer',
            })
            if (answer.answered) {
              db().query("UPDATE run SET status='running' WHERE id=? AND status='asking'").run(runId)
              elicitation = null
              return { action: 'accept' as const, content: { [stringFields[0]![0]]: answer.answer } }
            }
            elicitationFallback = 'ACP elicitation received no ruling before the ask-channel timeout'
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
    .onNotification(acp.methods.client.session.update, (req) => {
      // orch records the update as a run event; the store never holds ACP.
      updates.push(req.params)
      const folded = normalizeAcpTurn({ sessionId, updates: [req.params] })
      for (const event of folded.events) {
        if (event.kind === 'session' || event.kind === 'stop') continue
        pushEvent(event)
      }
    })

  const stream = webStream(child)
  connection = app.connect(stream)
  ctx = connection.agent

  try {
    await ctx.request(acp.methods.agent.initialize, {
      // orch advertises fs.read + form elicitation; write/terminal stay off.
      // Gap: usage_update.used is session context, not CLI input+output.
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: false },
        elicitation: { form: {} },
      },
      clientInfo: { name: 'orch', version: '0.1.0' },
    })
    // The ruling channel is transport infrastructure, not a project MCP opt-in.
    // codex-acp needs it on session/new. Grok loads the per-run config prepared
    // in GROK_HOME; passing the same stdio server here makes 1.0.13 reject
    // session/new with "Path not found."
    const mcpServers: acp.McpServer[] = !grok && opts.env.ORCH_RUN_ID && opts.env.ORCH_RUN_TOKEN
      ? [{
          name: 'orch-ask',
          command: process.execPath,
          args: [join(dirname(import.meta.path), 'cli.ts'), 'ask-server'],
          env: ['ORCH_ASK_URL', 'ORCH_RUN_ID', 'ORCH_RUN_TOKEN', 'ORCH_DB']
            .flatMap((name) => opts.env[name] ? [{ name, value: opts.env[name]! }] : []),
        }]
      : []
    if (opts.session) {
      await ctx.request(acp.methods.agent.session.load, {
        // orch resumes the vendor conversation; the prompt is the ruling.
        cwd: opts.cwd, sessionId: opts.session, mcpServers,
      })
      sessionId = opts.session
    } else {
      const created = await ctx.request(acp.methods.agent.session.new, {
        // orch opens a read-only session with its per-run ruling channel.
        cwd: opts.cwd, mcpServers,
      })
      sessionId = created.sessionId
    }
    if (sessionId) pushEvent({ kind: 'session', sessionId })
  } catch (error) {
    closed = true
    try { child.kill('SIGTERM') } catch { /* already gone */ }
    if (leaderSocket) rmSync(leaderSocket, { force: true })
    throw error
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
    kill(sig) {
      try { child.kill(sig === 9 || sig === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM') } catch { /* already gone */ }
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
        } catch { /* schema is best-effort on the wire; run.ts validates */ }
      }
      const promptWork = ctx.request(acp.methods.agent.session.prompt, {
        // orch sends the bound prompt as text blocks; schema is also inlined.
        sessionId, prompt: blocks,
      })
      collectPromise = (async () => {
        let stopReason: string | null = null
        let error: string | null = null
        try {
          const response = await promptWork
          stopReason = response.stopReason
          const meta = isRecord(response._meta) ? response._meta : null
          const nested = meta && isRecord(meta.usage) ? meta.usage : null
          const direct = isRecord(response.usage) ? response.usage : null
          const usage = (nested ?? direct) as Record<string, unknown> | null
          const inputTokens = usage && typeof usage.inputTokens === 'number' ? usage.inputTokens : undefined
          const outputTokens = usage && typeof usage.outputTokens === 'number' ? usage.outputTokens : undefined
          const totalTokens = usage && typeof usage.totalTokens === 'number' ? usage.totalTokens : undefined
          const costTicks = usage && typeof usage.costUsdTicks === 'number' ? usage.costUsdTicks : undefined
          terminalUsage = usage ? {
            inputTokens, outputTokens, totalTokens,
            costUsd: costTicks === undefined ? undefined : costTicks / 1_000_000_000,
          } : null
        } catch (cause) {
          error = String((cause as Error)?.message ?? cause)
        }
        const stderr = Buffer.concat(stderrChunks).toString('utf8')
        const result = normalizeAcpTurn({
          sessionId, updates, stopReason, elicitation, error, usage: terminalUsage,
          timedOut: cancelled,
          permissionEvents,
        })
        result.stderr = elicitationFallback
          ? [stderr, elicitationFallback].filter(Boolean).join('\n')
          : stderr
        result.pid = child.pid ?? null
        writeFileSync(opts.outPath, result.output)
        if (result.stopReason) pushEvent({ kind: 'stop', reason: result.stopReason })
        closed = true
        finishEvents()
        try { connection?.close() } catch { /* already closed */ }
        // Both paid adapters are long-lived stdio servers. A completed prompt is
        // the end of this orch run, so do not leave the adapter (or Grok's
        // per-run leader) alive after its result has been collected.
        try { child.kill('SIGTERM') } catch { /* already exited */ }
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
        } catch { /* agent may already be gone */ }
      }
      try { child.kill('SIGTERM') } catch { /* already gone */ }
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

export const acpTransport: AgentTransport = {
  name: 'acp',
  start(opts) { return openAcp(opts) },
  prompt(handle, text) { return handle.prompt(text) },
  events(handle) { return handle.events() },
  cancel(handle) { return handle.cancel() },
  resume(opts) { return openAcp({ ...opts, resume: true }) },
}
