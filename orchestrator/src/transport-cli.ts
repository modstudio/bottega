import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type {
  AgentTransport, NormalizedEvent, TransportHandle, TransportResult, TransportStartOpts,
} from './transport.ts'

/** Codex reports "tokens used\\n<n>" on stderr; other agents report nothing. */
function parseVendorTokens(blob: string): number | null {
  const m = blob.match(/tokens used\s*\n?\s*([\d,]+)/i)
  return m ? Number(m[1]!.replace(/,/g, '')) : null
}

function eventsFromCli(opts: {
  stdout: string
  sessionId: string | null
  tokens: number | null
  costUsd: number | null
  text: string
  error: string | null
  stopReason: string | null
}): NormalizedEvent[] {
  const events: NormalizedEvent[] = []
  if (opts.sessionId) events.push({ kind: 'session', sessionId: opts.sessionId })
  for (const line of opts.stdout.split('\n')) {
    const s = line.trimStart()
    if (!s.startsWith('{')) continue
    try {
      const e = JSON.parse(s) as { type?: string; item?: { type?: string; text?: string } }
      if (e.type === 'item.completed' && e.item?.type === 'agent_message' && e.item.text) {
        events.push({ kind: 'text', text: String(e.item.text) })
      }
    } catch { /* a half-written line is not an event */ }
  }
  if (opts.tokens !== null) events.push({ kind: 'usage', tokens: opts.tokens, costUsd: opts.costUsd })
  if (opts.error) events.push({ kind: 'error', error: opts.error })
  if (opts.stopReason) events.push({ kind: 'stop', reason: opts.stopReason })
  else if (opts.text || opts.error) events.push({ kind: 'stop', reason: opts.error ? 'error' : 'end_turn' })
  return events
}

function spawnCli(opts: TransportStartOpts): TransportHandle {
  const p = Bun.spawn(opts.launchArgv, {
    cwd: opts.cwd,
    env: opts.env,
    stdin: opts.stdinPrompt !== undefined ? new TextEncoder().encode(opts.stdinPrompt) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  let cancelled = false
  let collected: Promise<TransportResult> | null = null
  const eventWaiters: Array<(events: NormalizedEvent[]) => void> = []
  let recordedEvents: NormalizedEvent[] | null = null

  const collect = (): Promise<TransportResult> => {
    if (collected) return collected
    collected = (async () => {
      const [stdout, stderr] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
      ])
      const exitCode = await p.exited
      const reply = opts.agent.parseReply?.(stdout)
      const replyError = reply?.error ?? null
      const tokens = reply?.tokens ?? parseVendorTokens(stderr) ?? parseVendorTokens(stdout)
      const costUsd = reply?.costUsd ?? null
      const sessionId = opts.session ??
        opts.agent.readSession?.({
          stdout, cwd: opts.cwd, prompt: opts.prompt, startedAt: opts.startedAt,
          home: opts.home,
        }) ?? null
      let output = ''
      if (replyError) {
        output = stdout
        writeFileSync(opts.outPath, output)
      } else if (opts.agent.readsOut && existsSync(opts.outPath)) {
        output = readFileSync(opts.outPath, 'utf8').trim()
      }
      if (!replyError && !output) {
        output = (reply?.text ?? stdout).trim()
        if (output) writeFileSync(opts.outPath, output)
      }
      const stopReason = reply?.stopReason ?? (cancelled ? 'cancelled' : null)
      const events = eventsFromCli({
        stdout, sessionId, tokens, costUsd, text: output, error: replyError, stopReason,
      })
      recordedEvents = events
      for (const wait of eventWaiters) wait(events)
      eventWaiters.length = 0
      return {
        output, stdout, stderr, raw: stdout,
        parsed: reply ?? null,
        tokens, costUsd, sessionId, stopReason, error: replyError,
        exitCode, pid: p.pid, events, asking: false, questions: [],
      }
    })()
    return collected
  }

  const handle: TransportHandle = {
    pid: p.pid,
    kill(sig) { try { p.kill(sig === 9 || sig === 'SIGKILL' ? 9 : 'SIGTERM') } catch { /* already gone */ } },
    async prompt() { /* first-turn prompt is on argv / stdin */ },
    async *events() {
      const result = await collect()
      for (const event of recordedEvents ?? result.events) yield event
    },
    async cancel() {
      cancelled = true
      try { p.kill('SIGTERM') } catch { /* already gone */ }
    },
    collect,
  }
  return handle
}

export const cliTransport: AgentTransport = {
  name: 'cli',
  start(opts) { return Promise.resolve(spawnCli(opts)) },
  prompt(handle, text) { return handle.prompt(text) },
  events(handle) { return handle.events() },
  cancel(handle) { return handle.cancel() },
  resume(opts) { return Promise.resolve(spawnCli(opts)) },
}
