import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { constants as osConstants } from 'node:os'
import { execa } from 'execa'
import { eventsFromVendorLine } from './events.ts'
import { DEFAULT_IDLE_GRACE_MS, terminateProcessGroup } from './idle-kill.ts'
import { srtLaunchArgv } from './sandbox.ts'
import {
  outcomeFromTransport, registerTransport, type AgentTransport, type ArgvOpts, type NormalizedEvent, type TransportHandle,
  type TransportResult, type TransportStartOpts,
} from './transport.ts'

/** Codex reports "tokens used\\n<n>" on stderr; other agents report nothing. */
function parseVendorTokens(blob: string): number | null {
  const m = blob.match(/tokens used\s*\n?\s*([\d,]+)/i)
  return m ? Number(m[1]!.replace(/,/g, '')) : null
}

async function readStdoutLines(
  stream: AsyncIterable<string | Uint8Array>,
  onLine: (line: string) => void,
): Promise<string> {
  const decoder = new TextDecoder()
  let buf = ''
  let stdout = ''
  for await (const value of stream) {
    buf += typeof value === 'string' ? value : decoder.decode(value, { stream: true })
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
  const p = execa(launchArgv[0]!, launchArgv.slice(1), {
    cwd: opts.cwd,
    env: opts.env,
    stdin: stdinPrompt !== undefined ? 'pipe' : 'ignore', input: stdinPrompt,
    stdout: 'pipe', stderr: 'pipe',
    detached: true, cleanup: true, killSignal: 'SIGTERM', extendEnv: false,
    forceKillAfterDelay: DEFAULT_IDLE_GRACE_MS, reject: false,
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

  const stdoutTask = readStdoutLines(p.stdout!, (line) => {
    for (const event of eventsFromVendorLine(line)) pushEvent(event)
  })

  const finishEvents = () => {
    closed = true
    for (const waiter of eventWaiters) waiter()
    eventWaiters.length = 0
  }

  const collect = (): Promise<TransportResult> => {
    if (collected) return collected
    collected = (async () => {
     try {
      const [stdout, processResult] = await Promise.all([stdoutTask, p])
      const stderr = processResult.stderr
      const exitCode = processResult.exitCode ??
        (processResult.signal ? 128 + (osConstants.signals[processResult.signal] ?? 0) : 1)
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
        exitCode, pid: p.pid ?? null, events, asking: false,
        failureKind: folded.failureKind, status: folded.status, questions: [],
      }
     } finally {
      // Waiters on events() must wake on every exit, including a throw
      // from writeFileSync, parseReply or readSession (review 349).
      finishEvents()
     }
    })()
    return collected
  }

  const handle: TransportHandle = {
    pid: p.pid ?? null, kill(sig) {
      p.kill(typeof sig === 'number' ? sig : (sig ?? 'SIGTERM') as NodeJS.Signals)
    },
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
      void terminateProcessGroup(p.pid ?? 0, { direct: p })
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

export function registerCliTransport(): void {
  registerTransport('cli', () => cliTransport)
}

registerCliTransport()
