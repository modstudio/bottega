import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { ArgvOpts } from './agents.ts'
import { eventsFromVendorLine } from './events.ts'
import { srtLaunchArgv } from './sandbox.ts'
import {
  outcomeFromTransport, type AgentTransport, type NormalizedEvent, type TransportHandle,
  type TransportResult, type TransportStartOpts,
} from './transport.ts'

/** Codex reports "tokens used\\n<n>" on stderr; other agents report nothing. */
function parseVendorTokens(blob: string): number | null {
  const m = blob.match(/tokens used\s*\n?\s*([\d,]+)/i)
  return m ? Number(m[1]!.replace(/,/g, '')) : null
}

async function readStdoutLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<string> {
  const decoder = new TextDecoder()
  let buf = ''
  let stdout = ''
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl = buf.indexOf('\n')
    while (nl >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      stdout += `${line}\n`
      onLine(line)
      nl = buf.indexOf('\n')
    }
  }
  buf += decoder.decode()
  if (buf) {
    stdout += buf
    onLine(buf)
  }
  return stdout
}

function spawnCli(opts: TransportStartOpts): TransportHandle {
  const argvOpts: ArgvOpts = {
    prompt: opts.prompt,
    out: opts.outPath,
    schema: opts.schemaPath,
    mcp: opts.mcp,
    trustCwd: opts.trustCwd,
    model: opts.model,
    write: opts.write,
    sandbox: opts.sandbox,
    writableRoots: opts.writableRoots,
    gitObjectEnvironment: opts.gitObjectEnvironment,
    gitConfigEnvironment: opts.gitConfigEnvironment,
    session: opts.session,
  }
  const argv = opts.resume && opts.session && opts.agent.resumeArgv
    ? opts.agent.resumeArgv({ ...argvOpts, session: opts.session })
    : opts.agent.argv(argvOpts)
  const bin = opts.bin ?? opts.agent.bin
  const launchArgv = opts.srt
    ? srtLaunchArgv(opts.srt.profile, opts.srt.settingsPath, bin, argv)
    : [bin, ...argv]
  const stdinPrompt = opts.agent.stdin && !opts.resume ? opts.prompt : undefined
  const p = Bun.spawn(launchArgv, {
    cwd: opts.cwd,
    env: opts.env,
    stdin: stdinPrompt !== undefined ? new TextEncoder().encode(stdinPrompt) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  let cancelled = false
  let collected: Promise<TransportResult> | null = null
  const liveEvents: NormalizedEvent[] = []
  const eventWaiters: Array<() => void> = []
  let closed = false

  const pushEvent = (event: NormalizedEvent) => {
    liveEvents.push(event)
    eventWaiters.shift()?.()
  }

  const stdoutTask = readStdoutLines(p.stdout, (line) => {
    for (const event of eventsFromVendorLine(line)) pushEvent(event)
  })
  const stderrTask = new Response(p.stderr).text()

  const finishEvents = () => {
    closed = true
    for (const waiter of eventWaiters) waiter()
    eventWaiters.length = 0
  }

  const collect = (): Promise<TransportResult> => {
    if (collected) return collected
    collected = (async () => {
      const [stdout, stderr] = await Promise.all([stdoutTask, stderrTask])
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
      const stopReason = reply?.stopReason ?? (cancelled ? 'timeout' : null)
      const events: NormalizedEvent[] = []
      if (sessionId) events.push({ kind: 'session', sessionId })
      if (output) events.push({ kind: 'text', text: output })
      if (tokens !== null) events.push({ kind: 'usage', tokens, costUsd })
      if (replyError) events.push({ kind: 'error', error: replyError })
      if (stopReason) events.push({ kind: 'stop', reason: stopReason })
      const folded = outcomeFromTransport({
        asking: false, error: replyError, exitCode, output, stopReason,
      })
      finishEvents()
      return {
        output, stdout, stderr, raw: stdout,
        parsed: reply ?? null,
        tokens, costUsd, sessionId, stopReason, error: replyError,
        exitCode, pid: p.pid, events, asking: false,
        failureKind: folded.failureKind, status: folded.status, questions: [],
      }
    })()
    return collected
  }

  const handle: TransportHandle = {
    pid: p.pid,
    kill(sig) { try { p.kill(sig === 9 || sig === 'SIGKILL' ? 9 : 'SIGTERM') } catch { /* already gone */ } },
    async prompt() { /* first-turn prompt is on argv / stdin */ },
    async *events() {
      let i = 0
      for (;;) {
        if (i < liveEvents.length) {
          yield liveEvents[i++]!
          continue
        }
        if (closed) break
        await new Promise<void>((resolve) => { eventWaiters.push(resolve) })
      }
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
  resume(opts) { return Promise.resolve(spawnCli({ ...opts, resume: true })) },
}
