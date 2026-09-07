import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { ArgvOpts } from './agents.ts'
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
      recordedEvents = events
      for (const wait of eventWaiters) wait(events)
      eventWaiters.length = 0
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
  resume(opts) { return Promise.resolve(spawnCli({ ...opts, resume: true })) },
}
