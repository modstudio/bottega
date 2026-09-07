import { spawn, type ChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { readFileSync, writeFileSync } from 'node:fs'
import * as acp from '@agentclientprotocol/sdk'
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
  let tokens: number | null = null
  let costUsd: number | null = null
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
  if (!child.stdin || !child.stdout) throw new Error('codex-acp stdio is not a pipe')
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

async function openAcp(opts: TransportStartOpts): Promise<TransportHandle> {
  const bin = opts.bin ?? resolveCodexAcpBin()
  const child = spawn(bin, [], {
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
    .onRequest(acp.methods.client.elicitation.create, (req) => {
      // orch maps the elicitation message onto the ask channel and cancels the
      // form. Gap: the architect's ruling is not posted back as accept content;
      // the next turn resumes via session/load instead.
      elicitation = { message: req.params.message }
      pushEvent({ kind: 'elicitation', message: req.params.message })
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
    if (opts.session) {
      await ctx.request(acp.methods.agent.session.load, {
        // orch resumes the vendor conversation; the prompt is the ruling.
        cwd: opts.cwd, sessionId: opts.session, mcpServers: [],
      })
      sessionId = opts.session
    } else {
      const created = await ctx.request(acp.methods.agent.session.new, {
        // orch opens a read-only session in the worktree; no MCP servers yet.
        cwd: opts.cwd, mcpServers: [],
      })
      sessionId = created.sessionId
    }
    if (sessionId) pushEvent({ kind: 'session', sessionId })
  } catch (error) {
    closed = true
    try { child.kill('SIGTERM') } catch { /* already gone */ }
    throw error
  }

  let collectPromise: Promise<TransportResult> | null = null
  let cancelled = false

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
        } catch (cause) {
          error = String((cause as Error)?.message ?? cause)
        }
        const stderr = Buffer.concat(stderrChunks).toString('utf8')
        const result = normalizeAcpTurn({
          sessionId, updates, stopReason, elicitation, error,
          timedOut: cancelled,
          permissionEvents,
        })
        result.stderr = stderr
        result.pid = child.pid ?? null
        writeFileSync(opts.outPath, result.output)
        if (result.stopReason) pushEvent({ kind: 'stop', reason: result.stopReason })
        closed = true
        finishEvents()
        try { connection?.close() } catch { /* already closed */ }
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
