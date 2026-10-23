// concern: board-watch
/** Holds the hosted board stream and pulls the cache. Must not know SQL or the hosted stream server. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { installationBuildId } from '../../../shared/install-root.ts'
import { resolveRecordApiUrl } from '../../../shared/record-api-url.ts'
import { RECORD_SIGN_IN_REMEDY } from '../../../shared/record-remedies.ts'
import { enableSchemaReload } from '../database/db.ts'
import { type RecordBoardStreamOpen, recordApiClient } from '../record/record-api-client.ts'
import { hostedBoardCursor, refreshHostedBoard } from './board-hosted-cache.ts'
import {
  BOARD_WATCH_BUILD_CHECK_MS,
  type BoardWatchAnnounce,
  type BoardWatchDecision,
  type BoardWatchEvent,
  type BoardWatchState,
  boardWatchAdoptBuild,
  boardWatchDueEvent,
  boardWatchPullEvent,
  boardWatchWaitMs,
  decideBoardWatch,
  initialBoardWatchState,
} from './board-watch-decision.ts'
import { type BoardStreamFrame, createBoardStreamParser } from './board-watch-frames.ts'

const BOARD_WATCH_REFRESH_BUDGET_MS = 30_000
export const BOARD_WATCH_ERROR_DETAIL_MAX = 240
export const BOARD_WATCH_UNCONFIGURED_REMEDY = `BOTTEGA_RECORD_API_URL is not set; cleared by: ${PLATFORM_SLUG} record doctor`

export type BoardWatchOpen = RecordBoardStreamOpen

type PullGate = { pulling: boolean; queued: boolean }

export type BoardWatchPullResult =
  | { kind: 'ok'; applied: number }
  | { kind: 'incomplete'; applied: number }
  | { kind: 'failed'; reason: string }

export type BoardWatchLoopInput = {
  now: () => number
  wait: (ms: number, signal: AbortSignal) => Promise<'elapsed' | 'aborted'>
  openStream: (signal: AbortSignal) => Promise<BoardWatchOpen>
  pull: () => Promise<BoardWatchPullResult>
  readCursor: () => string
  readBuild: () => string | null
  startedBuild: string | null
  configured: boolean
  random: () => number
  log: (line: string) => void
  signal: AbortSignal
  decide?: typeof decideBoardWatch
}

type LiveWatch = {
  state: BoardWatchState
  target: string | null
  lastBuild: number
  startedBuild: string | null
}

const iso = (now: number) => new Date(now).toISOString()

async function waitFor(ms: number, signal: AbortSignal): Promise<'elapsed' | 'aborted'> {
  if (signal.aborted) return 'aborted'
  if (ms <= 0) return 'elapsed'
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve('elapsed')
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve('aborted')
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function decide(
  input: BoardWatchLoopInput,
  state: BoardWatchState,
  event: BoardWatchEvent,
): BoardWatchDecision {
  return (input.decide ?? decideBoardWatch)(state, event, input.random())
}

function announceLine(at: string, announce: BoardWatchAnnounce): string {
  switch (announce.kind) {
    case 'connected':
      return `${at} connected`
    case 'signed-out':
      return `${at} signed out; ${RECORD_SIGN_IN_REMEDY}`
    case 'disconnected':
      return `${at} disconnected ${announce.reason}${announce.reason === 'error' ? ` ${announce.detail}` : ''}`
    case 'unconfigured':
      return `${at} ${BOARD_WATCH_UNCONFIGURED_REMEDY}`
    case 'newer-build':
      return `${at} exiting for a newer build`
    case 'pull-failed':
      return `${at} pull failed ${announce.detail}`
    case 'pulling-again':
      return `${at} pulling again`
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function isWatchShutdownAbort(signal: AbortSignal, error: unknown): boolean {
  return signal.aborted && isAbortError(error)
}

function errorDetail(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error
  const message = error instanceof Error ? error.message : String(error)
  const firstNameLine = name.split(/\r?\n/, 1)[0]
  const firstMessageLine = message.split(/\r?\n/, 1)[0]
  return `${firstNameLine}: ${firstMessageLine}`.slice(0, BOARD_WATCH_ERROR_DETAIL_MAX)
}

function announce(input: BoardWatchLoopInput, decision: BoardWatchDecision): void {
  if (decision.announce) input.log(announceLine(iso(input.now()), decision.announce))
}

export async function runBoardWatchLoop(input: BoardWatchLoopInput): Promise<number> {
  if (!input.configured) {
    const decision = decide(input, initialBoardWatchState(), { kind: 'unconfigured' })
    announce(input, decision)
    return decision.exitCode ?? 0
  }
  const gate: PullGate = { pulling: false, queued: false }
  const live: LiveWatch = {
    state: initialBoardWatchState(),
    target: null,
    lastBuild: input.now(),
    startedBuild: input.startedBuild,
  }
  while (!input.signal.aborted) {
    try {
      const ended = await oneConnection(input, live, gate)
      if (ended !== null) return ended
    } catch (error) {
      if (isWatchShutdownAbort(input.signal, error)) return 0
      const ended = connectionResult(
        await applyReconnect(
          input,
          live,
          decide(input, live.state, { kind: 'error', detail: errorDetail(error) }),
        ),
      )
      if (ended !== null) return ended
    }
  }
  return 0
}

async function oneConnection(
  input: BoardWatchLoopInput,
  live: LiveWatch,
  gate: PullGate,
): Promise<number | null> {
  const build = checkBuild(input, live)
  if (build !== null) return build
  const opened = await input.openStream(input.signal)
  if (input.signal.aborted) return 0
  if (opened.kind !== 'stream') {
    const event: BoardWatchEvent =
      opened.kind === 'unauthorized'
        ? { kind: 'unauthorized' }
        : { kind: 'error', detail: opened.reason }
    const result = await applyReconnect(input, live, decide(input, live.state, event))
    return typeof result === 'number' ? result : null
  }
  const openedDecision = decide(input, live.state, { kind: 'opened' })
  live.state = openedDecision.state
  announce(input, openedDecision)
  if (openedDecision.pull) queuePull(input, live, gate)
  try {
    return await holdStream(input, opened.source, live, gate)
  } finally {
    opened.close()
  }
}

function checkBuild(input: BoardWatchLoopInput, live: LiveWatch): number | null {
  if (input.now() - live.lastBuild < BOARD_WATCH_BUILD_CHECK_MS) return null
  return dueBuildExit(input, live)
}

function dueBuildExit(input: BoardWatchLoopInput, live: LiveWatch): number | null {
  live.lastBuild = input.now()
  const adopted = boardWatchAdoptBuild(live.startedBuild, input.readBuild())
  live.startedBuild = adopted.started
  if (!adopted.changed) return null
  const decision = decide(input, live.state, { kind: 'build-changed' })
  announce(input, decision)
  return decision.exitCode ?? 0
}

async function applyReconnect(
  input: BoardWatchLoopInput,
  live: LiveWatch,
  decision: BoardWatchDecision,
): Promise<number | 'reconnect' | 'stay'> {
  live.state = decision.state
  announce(input, decision)
  if (decision.action === 'exit') return decision.exitCode ?? 0
  if (decision.action !== 'reconnect') return 'stay'
  if ((await input.wait(decision.delayMs, input.signal)) === 'aborted') return 0
  return 'reconnect'
}

function connectionResult(result: number | 'reconnect' | 'stay'): number | null {
  return typeof result === 'number' ? result : null
}

function queuePull(input: BoardWatchLoopInput, live: LiveWatch, gate: PullGate): void {
  void requestPull(input, live, gate).catch((error) => {
    if (isWatchShutdownAbort(input.signal, error)) return
    const reason = error instanceof Error ? error.message : String(error)
    const decision = decide(input, live.state, { kind: 'pull-failed', reason })
    live.state = decision.state
    announce(input, decision)
  })
}

async function requestPull(
  input: BoardWatchLoopInput,
  live: LiveWatch,
  gate: PullGate,
): Promise<void> {
  if (gate.pulling) {
    gate.queued = true
    return
  }
  gate.pulling = true
  try {
    do {
      gate.queued = false
      await runOnePull(input, live, gate)
    } while (gate.queued && !input.signal.aborted)
  } finally {
    gate.pulling = false
  }
}

async function runOnePull(
  input: BoardWatchLoopInput,
  live: LiveWatch,
  gate: PullGate,
): Promise<void> {
  let result: BoardWatchPullResult
  try {
    result = await input.pull()
  } catch (error) {
    if (isWatchShutdownAbort(input.signal, error)) return
    result = { kind: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
  if (input.signal.aborted) return
  if (result.kind !== 'failed' && result.applied > 0)
    input.log(`${iso(input.now())} pulled ${result.applied}`)
  const event = boardWatchPullEvent(result, input.readCursor(), live.target)
  if (event === null) {
    live.target = null
    return
  }
  const decision = decide(input, live.state, event)
  live.state = decision.state
  announce(input, decision)
  if (decision.action === 'exit' || !decision.pull) {
    if (!decision.pull) live.target = null
    return
  }
  if (decision.delayMs > 0 && (await input.wait(decision.delayMs, input.signal)) === 'aborted')
    return
  gate.queued = true
}

function consumeFrames(
  input: BoardWatchLoopInput,
  frames: BoardStreamFrame[],
  live: LiveWatch,
  sawEvent: boolean,
): { sawEvent: boolean; pull: boolean } {
  let seen = sawEvent
  let pull = false
  for (const frame of frames) {
    if (frame.kind !== 'event') continue
    if (!seen) {
      seen = true
      live.state = decide(input, live.state, { kind: 'first-event' }).state
    }
    const decision = decide(input, live.state, {
      kind: 'event',
      revision: frame.revision,
      cursor: input.readCursor(),
    })
    live.state = decision.state
    if (decision.pull) {
      pull = true
      live.target =
        live.target === null || BigInt(frame.revision) > BigInt(live.target)
          ? frame.revision
          : live.target
    }
  }
  return { sawEvent: seen, pull }
}

async function readOrWait(
  pending: { read: Promise<Uint8Array | null> | null },
  source: { read(): Promise<Uint8Array | null> },
  waitMs: number,
  wait: BoardWatchLoopInput['wait'],
  signal: AbortSignal,
): Promise<{ kind: 'chunk'; value: Uint8Array | null } | { kind: 'timer' } | { kind: 'aborted' }> {
  pending.read ??= source.read()
  const raced = await Promise.race([
    pending.read.then(
      (value) => ({ kind: 'chunk' as const, value }),
      (error: unknown) => ({ kind: 'read-error' as const, error }),
    ),
    wait(waitMs, signal).then((result) =>
      result === 'aborted'
        ? ({ kind: 'aborted' as const } as const)
        : ({ kind: 'timer' as const } as const),
    ),
  ])
  if (raced.kind === 'chunk') pending.read = null
  if (raced.kind === 'read-error') {
    pending.read = null
    if (isWatchShutdownAbort(signal, raced.error)) return { kind: 'aborted' }
    throw raced.error
  }
  return raced
}

type HoldClock = { lastByte: number; lastSlow: number; sawEvent: boolean }

async function holdStream(
  input: BoardWatchLoopInput,
  source: { read(): Promise<Uint8Array | null> },
  live: LiveWatch,
  gate: PullGate,
): Promise<number | null> {
  const decoder = new TextDecoder()
  const parser = createBoardStreamParser()
  const pending: { read: Promise<Uint8Array | null> | null } = { read: null }
  const clock: HoldClock = { lastByte: input.now(), lastSlow: input.now(), sawEvent: false }
  while (!input.signal.aborted) {
    const ended = await holdTurn(input, source, live, gate, decoder, parser, pending, clock)
    if (ended !== 'continue') return ended
  }
  return 0
}

async function holdTurn(
  input: BoardWatchLoopInput,
  source: { read(): Promise<Uint8Array | null> },
  live: LiveWatch,
  gate: PullGate,
  decoder: TextDecoder,
  parser: ReturnType<typeof createBoardStreamParser>,
  pending: { read: Promise<Uint8Array | null> | null },
  clock: HoldClock,
): Promise<number | null | 'continue'> {
  const raced = await readOrWait(
    pending,
    source,
    boardWatchWaitMs({
      now: input.now(),
      lastByte: clock.lastByte,
      lastSlow: clock.lastSlow,
      lastBuild: live.lastBuild,
    }),
    input.wait,
    input.signal,
  )
  if (raced.kind === 'aborted') return 0
  if (raced.kind === 'timer') return await holdTimer(input, live, gate, clock)
  if (raced.value === null) {
    return connectionResult(
      await applyReconnect(input, live, decide(input, live.state, { kind: 'ended' })),
    )
  }
  clock.lastByte = input.now()
  const parsed = parser.push(decoder.decode(raced.value, { stream: true }))
  if (parsed.protocolError) {
    return connectionResult(
      await applyReconnect(
        input,
        live,
        decide(input, live.state, {
          kind: 'error',
          detail: 'Error: invalid board stream frame',
        }),
      ),
    )
  }
  const consumed = consumeFrames(input, parsed.frames, live, clock.sawEvent)
  clock.sawEvent = consumed.sawEvent
  if (consumed.pull) queuePull(input, live, gate)
  return 'continue'
}

async function holdTimer(
  input: BoardWatchLoopInput,
  live: LiveWatch,
  gate: PullGate,
  clock: HoldClock,
): Promise<number | null | 'continue'> {
  const timer = await applyTimer(
    input,
    live,
    gate,
    boardWatchDueEvent({
      now: input.now(),
      lastByte: clock.lastByte,
      lastSlow: clock.lastSlow,
      lastBuild: live.lastBuild,
    }),
  )
  if (timer.exit !== null) return timer.exit
  if (timer.reconnect) return null
  clock.lastSlow = timer.lastSlow ?? clock.lastSlow
  return 'continue'
}

async function applyTimer(
  input: BoardWatchLoopInput,
  live: LiveWatch,
  gate: PullGate,
  due: ReturnType<typeof boardWatchDueEvent>,
): Promise<{ exit: number | null; reconnect: boolean; lastSlow?: number }> {
  if (due === 'silence') {
    const result = await applyReconnect(input, live, decide(input, live.state, { kind: 'silence' }))
    if (typeof result === 'number') return { exit: result, reconnect: false }
    return { exit: null, reconnect: result === 'reconnect' }
  }
  if (due === 'build-check') {
    const exit = dueBuildExit(input, live)
    return { exit, reconnect: false }
  }
  if (due === 'slow-timer') {
    const decision = decide(input, live.state, { kind: 'slow-timer' })
    live.state = decision.state
    announce(input, decision)
    if (decision.pull) queuePull(input, live, gate)
    return { exit: null, reconnect: false, lastSlow: input.now() }
  }
  return { exit: null, reconnect: false }
}

async function pullProduction(): Promise<BoardWatchPullResult> {
  try {
    const result = await refreshHostedBoard({ budgetMs: BOARD_WATCH_REFRESH_BUDGET_MS })
    if (result.status === 'failed') return { kind: 'failed', reason: result.reason ?? 'failed' }
    if (result.status === 'incomplete') return { kind: 'incomplete', applied: result.applied }
    return { kind: 'ok', applied: result.applied }
  } catch (error) {
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
}

export async function watchHostedBoard(): Promise<number> {
  enableSchemaReload()
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    const startedBuild = installationBuildId(import.meta.dir, process.env)
    return await runBoardWatchLoop({
      now: Date.now,
      wait: waitFor,
      openStream: (signal) => recordApiClient().openBoardStream(signal),
      pull: pullProduction,
      readCursor: () => hostedBoardCursor(),
      readBuild: () => installationBuildId(import.meta.dir, process.env),
      startedBuild,
      configured: Boolean(resolveRecordApiUrl()?.trim()),
      random: Math.random,
      log: (line) => console.log(line),
      signal: controller.signal,
    })
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
  }
}
