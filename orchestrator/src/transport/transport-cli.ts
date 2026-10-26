import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { constants as osConstants } from 'node:os'
import { execa } from 'execa'
import { workerHarnessName } from '../agent/worker-launch-env.ts'
import { eventsFromVendorLine } from '../events.ts'
import { DEFAULT_IDLE_GRACE_MS, terminateProcessGroup } from '../idle-kill.ts'
import { lowerRunChildPriority } from '../run/run-child-priority.ts'
import { sandboxLaunchArgv } from '../sandbox/sandbox.ts'
import { classifyCodexThrottle } from './codex-throttle.ts'
import {
  type AgentTransport,
  type ArgvOpts,
  EMPTY_VENDOR_USAGE,
  type NormalizedEvent,
  outcomeFromTransport,
  registerTransport,
  type TransportHandle,
  type TransportResult,
  type TransportStartOpts,
  type VendorUsage,
} from './transport.ts'
import { cliResultEvents } from './transport-result-events.ts'
import { type AgentBilling, usageForBilling } from './vendor-usage.ts'

/** Codex reports "tokens used\\n<n>" on stderr; other agents report nothing. */
function parseVendorTokens(blob: string): number | null {
  const m = blob.match(/tokens used\s*\n?\s*([\d,]+)/i)
  return m ? Number(m[1]!.replace(/,/g, '')) : null
}

function cliUsage(estimatedCostUsd: number | null) {
  const vendorUsage: VendorUsage =
    estimatedCostUsd === null
      ? EMPTY_VENDOR_USAGE
      : { ...EMPTY_VENDOR_USAGE, estimatedCostUsd, costSource: 'estimated' }
  return { costUsd: null, vendorUsage }
}

function eventForBilling(billing: AgentBilling, event: NormalizedEvent): NormalizedEvent {
  if (event.kind !== 'usage') return event
  const usage = usageForBilling(billing, {
    costUsd: event.costUsd,
    vendorUsage: EMPTY_VENDOR_USAGE,
  })
  return { ...event, costUsd: usage.costUsd }
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

function codexThrottleEvent(line: string): NormalizedEvent | null {
  const throttle = classifyCodexThrottle(line)
  if (!throttle) return null
  return {
    kind: 'throttled',
    attempt: throttle.attempt,
    max: throttle.max,
    retryDelayMs: throttle.retryDelayMs,
    httpStatus: throttle.status,
    retryAt:
      throttle.retryDelayMs === null
        ? null
        : new Date(Date.now() + throttle.retryDelayMs).toISOString(),
  }
}

export function startCliStreamReaders(input: {
  stdout: AsyncIterable<string | Uint8Array>
  stderr: AsyncIterable<string | Uint8Array>
  codex: boolean
  push: (event: NormalizedEvent) => void
}) {
  let throttleSeen = false
  const observeThrottle = (line: string) => {
    if (!input.codex || throttleSeen) return
    const event = codexThrottleEvent(line)
    if (!event) return
    throttleSeen = true
    input.push(event)
  }
  return {
    stdoutTask: readStdoutLines(input.stdout, (line) => {
      observeThrottle(line)
      for (const event of eventsFromVendorLine(line)) input.push(event)
    }),
    stderrTask: readStdoutLines(input.stderr, observeThrottle),
  }
}

function spawnCliChild(
  launchArgv: string[],
  opts: TransportStartOpts,
  stdinPrompt: string | undefined,
) {
  return lowerRunChildPriority(
    execa(launchArgv[0]!, launchArgv.slice(1), {
      cwd: opts.cwd,
      env: opts.env,
      stdin: stdinPrompt !== undefined ? 'pipe' : 'ignore',
      input: stdinPrompt,
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
      cleanup: true,
      killSignal: 'SIGTERM',
      extendEnv: false,
      forceKillAfterDelay: DEFAULT_IDLE_GRACE_MS,
      reject: false,
    }),
    opts.onWarning,
  )
}

async function cliLaunch(opts: TransportStartOpts) {
  const argvOpts: ArgvOpts = {
    prompt: opts.prompt,
    out: opts.outPath,
    schema: opts.schemaPath,
    mcp: opts.mcp,
    mcpServer: opts.mcpServer,
    projectServers: opts.projectServers,
    home: opts.env.HOME,
    trustCwd: opts.trustCwd,
    model: opts.model,
    write: opts.write,
    sandbox: opts.sandbox,
    sandboxWorkspaceWriteNetworkAccess: opts.sandboxWorkspaceWriteNetworkAccess,
    writableRoots: opts.writableRoots,
    gitConfigEnvironment: opts.gitConfigEnvironment,
    recipeEnvironment: opts.recipeEnvironment,
    session: opts.session,
  }
  const argv =
    opts.resume && opts.session && opts.agent.resumeArgv
      ? opts.agent.resumeArgv({ ...argvOpts, session: opts.session })
      : opts.agent.argv(argvOpts)
  const bin = opts.bin ?? opts.agent.bin
  const launchArgv = opts.srt
    ? await sandboxLaunchArgv(opts.srt.profile, bin, argv)
    : [bin, ...argv]
  const stdinPrompt = opts.agent.stdin && !opts.resume ? opts.prompt : undefined
  return { launchArgv, stdinPrompt }
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: stream and process closure share one transport handle state
async function spawnCli(opts: TransportStartOpts): Promise<TransportHandle> {
  const { launchArgv, stdinPrompt } = await cliLaunch(opts)
  const p = spawnCliChild(launchArgv, opts, stdinPrompt)

  let cancelled = false
  let collected: Promise<TransportResult> | null = null
  const liveEvents: NormalizedEvent[] = []
  const eventWaiters: Array<() => void> = []
  let closed = false

  const pushEvent = (event: NormalizedEvent) => {
    liveEvents.push(event)
    eventWaiters.shift()?.()
  }
  const { stdoutTask, stderrTask } = startCliStreamReaders({
    stdout: p.stdout!,
    stderr: p.stderr!,
    codex: workerHarnessName(opts.agent) === 'codex',
    push: (event) => pushEvent(eventForBilling(opts.agent.billing, event)),
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
        const [stdout, stderr, processResult] = await Promise.all([stdoutTask, stderrTask, p])
        const signal = processResult.signal ?? null
        const exitCode =
          processResult.exitCode ?? (signal ? 128 + (osConstants.signals[signal] ?? 0) : 1)
        const reply = opts.agent.parseReply?.(stdout)
        const replyError = reply?.error ?? null
        const tokens = reply?.tokens ?? parseVendorTokens(stderr) ?? parseVendorTokens(stdout)
        const usage = usageForBilling(opts.agent.billing, cliUsage(reply?.costUsd ?? null))
        const sessionId =
          opts.session ??
          opts.agent.readSession?.({
            stdout,
            cwd: opts.cwd,
            prompt: opts.prompt,
            startedAt: opts.startedAt,
            home: opts.home,
          }) ??
          null
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
        const terminalEvents: NormalizedEvent[] = []
        if (sessionId) terminalEvents.push({ kind: 'session', sessionId })
        if (output) terminalEvents.push({ kind: 'text', text: output })
        if (tokens !== null)
          terminalEvents.push({
            kind: 'usage',
            tokens,
            costUsd: usage.costUsd,
            per: 'turn',
          })
        if (replyError) terminalEvents.push({ kind: 'error', error: replyError })
        if (stopReason) terminalEvents.push({ kind: 'stop', reason: stopReason })
        const events = cliResultEvents(liveEvents, terminalEvents)
        const folded = outcomeFromTransport({
          asking: false,
          error: replyError,
          exitCode,
          output,
          stopReason,
        })
        finishEvents()
        return {
          output,
          stdout,
          stderr,
          raw: stdout,
          parsed: reply ?? null,
          tokens,
          ...usage,
          sessionId,
          stopReason,
          error: replyError,
          exitCode,
          signal,
          pid: p.pid ?? null,
          events,
          asking: false,
          failureKind: folded.failureKind,
          status: folded.status,
          questions: [],
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
    pid: p.pid ?? null,
    kill(sig) {
      p.kill(typeof sig === 'number' ? sig : ((sig ?? 'SIGTERM') as NodeJS.Signals))
    },
    async prompt() {
      /* first-turn prompt is on argv / stdin */
    },
    async *events() {
      let i = 0
      for (;;) {
        if (i < liveEvents.length) {
          yield liveEvents[i++]!
          continue
        }
        if (closed) break
        await new Promise<void>((resolve) => {
          eventWaiters.push(resolve)
        })
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

export function configuredCliAsk(
  opts: Pick<TransportStartOpts, 'agent' | 'env'>,
): { kind: 'command'; argv: string[] } | null {
  const argv = opts.agent.askServerCommand?.(opts.env) ?? null
  return argv ? { kind: 'command', argv } : null
}

const cliTransport: AgentTransport = {
  name: 'cli',
  canInjectMidTurn: false,
  configuredAsk: configuredCliAsk,
  start(opts) {
    return spawnCli(opts)
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
    return spawnCli({ ...opts, resume: true })
  },
}

export function registerCliTransport(): void {
  registerTransport('cli', () => cliTransport)
}

registerCliTransport()
