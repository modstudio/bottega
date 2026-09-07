import { spawn, type ChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { readFileSync, writeFileSync } from 'node:fs'
import * as acp from '@agentclientprotocol/sdk'
import type {
  AgentTransport, NormalizedEvent, TransportHandle, TransportResult, TransportStartOpts,
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
 */
export function normalizeAcpTurn(input: AcpTurnInput): TransportResult {
  const events: NormalizedEvent[] = []
  const chunks: string[] = []
  let tokens: number | null = null
  let costUsd: number | null = null
  let sessionId = input.sessionId ?? null
  if (sessionId) events.push({ kind: 'session', sessionId })

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
  if (!error && !asking && !output.trim() && stopReason && stopReason !== 'end_turn') {
    error = `ACP stop reason: ${stopReason}`
  }
  if (!error && !asking && !output.trim() && !stopReason) {
    error = 'ACP turn produced no agent message'
  }

  const raw = input.updates.map((update) => JSON.stringify(update)).join('\n')
  let exitCode = 0
  if (asking) exitCode = 0
  else if (error) exitCode = stopReason === 'timeout' || stopReason === 'cancelled' ? 143 : 1

  return {
    output, stdout: raw, stderr: '', raw,
    parsed: { text: output, tokens, costUsd, stopReason, error: error ?? undefined },
    tokens, costUsd, sessionId, stopReason, error,
    exitCode, pid: null, events, asking,
    questions: asking && input.elicitation
      ? [{
          question: input.elicitation.message,
          why: 'ACP elicitation/create mapped to the orch ask channel',
        }]
      : [],
  }
}

export function acpOutcome(result: TransportResult): 'ok' | 'asking' | 'failed' {
  if (result.asking) return 'asking'
  if (result.error || result.exitCode !== 0 || !result.output.trim()) return 'failed'
  return 'ok'
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

function pickPermissionOption(
  options: Array<{ optionId: string; kind: string }>,
): { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } {
  const allow = options.find((option) => option.kind === 'allow_once')
    ?? options.find((option) => option.kind === 'allow_always')
  if (allow) return { outcome: 'selected', optionId: allow.optionId }
  return { outcome: 'cancelled' }
}

async function openAcp(opts: TransportStartOpts): Promise<TransportHandle> {
  const bin = opts.launchArgv[0]
  if (!bin) throw new Error('ACP launch argv is empty')
  const args = opts.launchArgv.slice(1)
  const child = spawn(bin, args, {
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
      const title = req.params.toolCall.title ?? 'tool'
      const optionKinds = req.params.options.map((option) => option.kind)
      pushEvent({ kind: 'permission', title, optionKinds })
      const selected = pickPermissionOption(req.params.options)
      return { outcome: selected }
    })
    .onRequest(acp.methods.client.elicitation.create, (req) => {
      elicitation = { message: req.params.message }
      pushEvent({ kind: 'elicitation', message: req.params.message })
      return { action: 'cancel' as const }
    })
    .onRequest(acp.methods.client.fs.readTextFile, (req) => {
      const content = readTextFile(req.params.path, req.params.line, req.params.limit)
      return { content }
    })
    .onNotification(acp.methods.client.session.update, (req) => {
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
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: false },
        elicitation: { form: {} },
      },
      clientInfo: { name: 'orch', version: '0.1.0' },
    })
    if (opts.session) {
      await ctx.request(acp.methods.agent.session.load, {
        cwd: opts.cwd, sessionId: opts.session, mcpServers: [],
      })
      sessionId = opts.session
    } else {
      const created = await ctx.request(acp.methods.agent.session.new, {
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
  let promptText = opts.prompt
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
      promptText = text
      const blocks: acp.ContentBlock[] = [{ type: 'text', text }]
      if (opts.schemaPath) {
        try {
          const schema = readFileSync(opts.schemaPath, 'utf8')
          blocks.push({
            type: 'text',
            text: `\nRespond with JSON matching this schema and nothing else:\n${schema}`,
          })
        } catch { /* schema is best-effort on ACP */ }
      }
      const promptWork = ctx.request(acp.methods.agent.session.prompt, {
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
          timedOut: cancelled && stopReason !== 'end_turn',
        })
        result.stderr = stderr
        result.pid = child.pid ?? null
        if (cancelled && result.stopReason !== 'end_turn') {
          result.stopReason = result.stopReason ?? 'cancelled'
          result.exitCode = 143
        }
        writeFileSync(opts.outPath, result.output)
        if (result.stopReason) pushEvent({ kind: 'stop', reason: result.stopReason })
        closed = true
        finishEvents()
        try { connection?.close() } catch { /* already closed */ }
        return result
      })()
      void promptText
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
  resume(opts) { return openAcp(opts) },
}
