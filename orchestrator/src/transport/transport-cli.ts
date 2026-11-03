import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { constants as osConstants } from 'node:os'
import { execa } from 'execa'
import { workerHarnessName } from '../agent/worker-launch-env.ts'
import { eventsFromVendorLine } from '../events.ts'
import { DEFAULT_IDLE_GRACE_MS, terminateProcessGroup } from '../idle-kill.ts'
import { lowerRunChildPriority } from '../run/run-child-priority.ts'
import { sandboxLaunchArgv } from '../sandbox/sandbox.ts'
import { codexAskExposureFromTexts } from './codex-ask-exposure.ts'
import { harnessCollectsQuotaReadings, parseCodexQuotaReadings } from './codex-quota.ts'
import {
  codexRolloutTextsSince,
  codexRolloutVersionHeads,
  confinedCodexRollouts,
} from './codex-rollout-files.ts'
import { classifyCodexThrottle } from './codex-throttle.ts'
import { EMPTY_QUOTA_READINGS } from './quota-readings.ts'
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

/** Most bytes this transport keeps from one child stream, stdout or stderr. */
export const CLI_OUTPUT_CAPTURE_BYTES = 64 * 1024 * 1024

/** What one child stream kept, and whether it outgrew the capture ceiling. */
type CliStreamCapture = { stream: 'stdout' | 'stderr'; text: string; overflow: boolean }

function cliUsage(estimatedCostUsd: number | null) {
  const vendorUsage: VendorUsage =
    estimatedCostUsd === null
      ? EMPTY_VENDOR_USAGE
      : { ...EMPTY_VENDOR_USAGE, estimatedCostUsd, costSource: 'estimated' }
  return { costUsd: null, vendorUsage }
}

export function codexRolloutEvidence(
  codex: boolean,
  home: string | undefined,
  offsets: Map<string, number>,
  capBytes?: number,
) {
  if (!codex) return { quotaReadings: EMPTY_QUOTA_READINGS, askExposure: undefined, overflow: null }
  const texts = codexRolloutTextsSince(home, offsets, capBytes)
  // A dropped slice has no readings to report; the overflow itself is the value.
  if (texts.overflow)
    return { quotaReadings: EMPTY_QUOTA_READINGS, askExposure: undefined, overflow: texts.overflow }
  return {
    quotaReadings: parseCodexQuotaReadings(texts.slice),
    // The version fallback reads bounded heads lazily, only when the slice
    // carries no `cli_version`.
    askExposure: codexAskExposureFromTexts(texts.slice, () => codexRolloutVersionHeads(home)),
    overflow: null,
  }
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
  stream: 'stdout' | 'stderr',
  input: AsyncIterable<string | Uint8Array>,
  onLine: (line: string) => void,
  captureBytes: number = CLI_OUTPUT_CAPTURE_BYTES,
): Promise<CliStreamCapture> {
  const decoder = new TextDecoder()
  let buf = ''
  let stdout = ''
  let kept = 0
  for await (const value of input) {
    const chunk = typeof value === 'string' ? value : decoder.decode(value, { stream: true })
    if (kept + Buffer.byteLength(chunk) > captureBytes)
      return { stream, text: stdout + buf, overflow: true }
    kept += Buffer.byteLength(chunk)
    buf += chunk
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
  return { stream, text: stdout, overflow: false }
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
  captureBytes?: number
  onCaptureOverflow?: (stream: 'stdout' | 'stderr') => void
}) {
  let throttleSeen = false
  const observeThrottle = (line: string) => {
    if (!input.codex || throttleSeen) return
    const event = codexThrottleEvent(line)
    if (!event) return
    throttleSeen = true
    input.push(event)
  }
  const capture = (
    stream: 'stdout' | 'stderr',
    source: AsyncIterable<string | Uint8Array>,
    onLine: (line: string) => void,
  ) =>
    readStdoutLines(stream, source, onLine, input.captureBytes).then((result) => {
      if (result.overflow) input.onCaptureOverflow?.(stream)
      return result
    })
  return {
    stdoutTask: capture('stdout', input.stdout, (line) => {
      observeThrottle(line)
      for (const event of eventsFromVendorLine(line)) input.push(event)
    }),
    stderrTask: capture('stderr', input.stderr, observeThrottle),
  }
}

/** Settle a finished turn's output and leave it at the turn's out path. */
function cliTurnOutput(
  opts: Pick<TransportStartOpts, 'agent' | 'outPath'>,
  turn: { replyError: string | null; replyText: string | undefined; stdout: string },
): string {
  if (turn.replyError) {
    writeFileSync(opts.outPath, turn.stdout)
    return turn.stdout
  }
  if (opts.agent.readsOut && existsSync(opts.outPath)) {
    const fromFile = readFileSync(opts.outPath, 'utf8').trim()
    if (fromFile) return fromFile
  }
  const output = (turn.replyText ?? turn.stdout).trim()
  if (output) writeFileSync(opts.outPath, output)
  return output
}

/** The events a finished CLI turn reports after its live stream. */
function cliTerminalEvents(turn: {
  sessionId: string | null
  output: string
  tokens: number | null
  costUsd: number | null
  error: string | null
  stopReason: string | null
}): NormalizedEvent[] {
  const events: NormalizedEvent[] = []
  if (turn.sessionId) events.push({ kind: 'session', sessionId: turn.sessionId })
  if (turn.output) events.push({ kind: 'text', text: turn.output })
  if (turn.tokens !== null)
    events.push({ kind: 'usage', tokens: turn.tokens, costUsd: turn.costUsd, per: 'turn' })
  if (turn.error) events.push({ kind: 'error', error: turn.error })
  if (turn.stopReason) events.push({ kind: 'stop', reason: turn.stopReason })
  return events
}

/** A stream that outgrew its declared capture ceiling, named with the remedy. */
function cliCaptureOverflowError(harness: string, stream: 'stdout' | 'stderr'): string {
  return `${harness} ${stream} exceeded CLI_OUTPUT_CAPTURE_BYTES (orchestrator/src/transport/transport-cli.ts); raise that constant if the harness legitimately prints more, then rerun`
}

/** The one capture that outgrew its ceiling, if either stream did. */
function overflowedCapture(
  stdout: CliStreamCapture,
  stderr: CliStreamCapture,
): CliStreamCapture | null {
  if (stdout.overflow) return stdout
  if (stderr.overflow) return stderr
  return null
}

type CliTurnReply = {
  text: string
  tokens: number | null
  costUsd: number | null
  stopReason?: string | null
  error?: string
}

/**
 * Read one turn from its captures. An overflowing stream has no reply to
 * trust, so the turn reads as the failure that names the stream.
 */
function cliTurnReading(input: {
  overflowed: CliStreamCapture | null
  harness: string
  parseReply: () => CliTurnReply | null
  stdout: string
  stderr: string
}): { reply: CliTurnReply | null; replyError: string | null; tokens: number | null } {
  if (input.overflowed)
    return {
      reply: null,
      replyError: cliCaptureOverflowError(input.harness, input.overflowed.stream),
      tokens: null,
    }
  const reply = input.parseReply()
  return {
    reply,
    replyError: reply?.error ?? null,
    tokens: reply?.tokens ?? parseVendorTokens(input.stderr) ?? parseVendorTokens(input.stdout),
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
    withheldProjectServers: opts.withheldProjectServers,
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
  const codex = harnessCollectsQuotaReadings(workerHarnessName(opts.agent))
  const codexHome = codex ? opts.env.CODEX_HOME : undefined
  const rolloutOffsets = codexRolloutOffsets(codexHome)
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
  const terminate = () => void terminateProcessGroup(p.pid ?? 0, { direct: p })
  const { stdoutTask, stderrTask } = startCliStreamReaders({
    stdout: p.stdout!,
    stderr: p.stderr!,
    codex,
    push: (event) => pushEvent(eventForBilling(opts.agent.billing, event)),
    // A stream past its ceiling cannot be read to the end, so the turn stops
    // there rather than keeping bytes for a child that must be killed anyway.
    onCaptureOverflow: terminate,
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
        const [stdoutCapture, stderrCapture, processResult] = await Promise.all([
          stdoutTask,
          stderrTask,
          p,
        ])
        const stdout = stdoutCapture.text
        const stderr = stderrCapture.text
        const overflowed = overflowedCapture(stdoutCapture, stderrCapture)
        const signal = processResult.signal ?? null
        const exitCode =
          processResult.exitCode ?? (signal ? 128 + (osConstants.signals[signal] ?? 0) : 1)
        const { reply, replyError, tokens } = cliTurnReading({
          overflowed,
          harness: workerHarnessName(opts.agent),
          parseReply: () => opts.agent.parseReply?.(stdout) ?? null,
          stdout,
          stderr,
        })
        const usage = usageForBilling(opts.agent.billing, cliUsage(reply?.costUsd ?? null))
        const { quotaReadings, askExposure, overflow } = codexRolloutEvidence(
          codex,
          codexHome,
          rolloutOffsets,
        )
        // Best-effort observation, reported where an operator will see it
        // without changing what the turn did.
        if (overflow) opts.onWarning?.(overflow.message)
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
        const output = cliTurnOutput(opts, { replyError, replyText: reply?.text, stdout })
        const stopReason = reply?.stopReason ?? (cancelled ? 'timeout' : null)
        const events = cliResultEvents(
          liveEvents,
          cliTerminalEvents({
            sessionId,
            output,
            tokens,
            costUsd: usage.costUsd,
            error: replyError,
            stopReason,
          }),
        )
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
          quotaReadings,
          askExposure,
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
      terminate()
    },
    collect,
  }
  return handle
}

function codexRolloutOffsets(home: string | undefined): Map<string, number> {
  const offsets = new Map<string, number>()
  for (const path of confinedCodexRollouts(home)) {
    try {
      offsets.set(path, statSync(path).size)
    } catch {
      // Rollout observation is best-effort and never changes the run outcome.
    }
  }
  return offsets
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
