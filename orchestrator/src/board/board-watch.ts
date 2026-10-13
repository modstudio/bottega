// concern: board-watch
/** Holds the hosted board stream and pulls the cache. Must not know SQL or the hosted stream server. */

import { installationVersionText } from '../../../shared/install-root.ts'
import { resolveRecordApiUrl } from '../../../shared/record-api-url.ts'
import { RECORD_SIGN_IN_REMEDY } from '../../../shared/record-remedies.ts'
import { enableSchemaReload } from '../database/db.ts'
import { recordApiClient } from '../record/record-api-client.ts'
import { hostedBoardCursor, refreshHostedBoard } from './board-hosted-cache.ts'
import {
  BOARD_WATCH_SILENCE_MS,
  BOARD_WATCH_SLOW_INTERVAL_MS,
  type BoardWatchDecision,
  type BoardWatchState,
  boardWatchShouldPull,
  decideBoardWatch,
  initialBoardWatchState,
} from './board-watch-decision.ts'
import { type BoardStreamFrame, createBoardStreamParser } from './board-watch-frames.ts'

export const BOARD_WATCH_REFRESH_BUDGET_MS = 30_000
export const BOARD_WATCH_UNCONFIGURED_REMEDY =
  'ORCH_RECORD_API_URL is not set; cleared by: orch record doctor'

export type BoardWatchChunkSource = {
  read(): Promise<Uint8Array | null>
}

export type BoardWatchOpen =
  | { kind: 'stream'; source: BoardWatchChunkSource; close: () => void }
  | { kind: 'unauthorized' }
  | { kind: 'error' }

type PullGate = { pulling: boolean; queued: boolean }

export type BoardWatchLoopInput = {
  now: () => number
  wait: (ms: number, signal: AbortSignal) => Promise<'elapsed' | 'aborted'>
  openStream: (signal: AbortSignal) => Promise<BoardWatchOpen>
  pull: () => Promise<number>
  readCursor: () => string
  readBuild: () => string
  startedBuild: string
  configured: boolean
  random: () => number
  log: (line: string) => void
  signal: AbortSignal
}

const iso = (now: number) => new Date(now).toISOString()

export async function waitFor(ms: number, signal: AbortSignal): Promise<'elapsed' | 'aborted'> {
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

export async function runBoardWatchLoop(input: BoardWatchLoopInput): Promise<number> {
  if (!input.configured) {
    input.log(`${iso(input.now())} ${BOARD_WATCH_UNCONFIGURED_REMEDY}`)
    return 1
  }
  const gate: PullGate = { pulling: false, queued: false }
  let state = initialBoardWatchState()
  while (!input.signal.aborted) {
    const step = await oneConnection(input, state, gate)
    state = step.state
    if (step.exit !== null) return step.exit
    if (step.delayMs !== null && (await input.wait(step.delayMs, input.signal)) === 'aborted')
      return 0
  }
  return 0
}

async function oneConnection(
  input: BoardWatchLoopInput,
  state: BoardWatchState,
  gate: PullGate,
): Promise<{ state: BoardWatchState; exit: number | null; delayMs: number | null }> {
  if (input.readBuild() !== input.startedBuild) {
    input.log(`${iso(input.now())} exiting for a newer build`)
    return { state, exit: 0, delayMs: null }
  }
  const opened = await input.openStream(input.signal)
  if (input.signal.aborted) return { state, exit: 0, delayMs: null }
  if (opened.kind !== 'stream') {
    const event = opened.kind === 'unauthorized' ? 'unauthorized' : 'ended-error'
    const decision = decideBoardWatch(state, { kind: event }, input.random())
    announce(input, decision)
    return { state: decision.state, exit: null, delayMs: decision.delayMs ?? 0 }
  }
  input.log(`${iso(input.now())} connected`)
  const afterOpen = decideBoardWatch(state, { kind: 'opened' }, input.random())
  void requestPull(input, gate)
  try {
    const held = await holdStream(input, opened.source, afterOpen.state, gate)
    announce(input, held.decision)
    if (held.decision.action === 'exit') return { state: held.state, exit: 0, delayMs: null }
    return { state: held.state, exit: null, delayMs: held.decision.delayMs ?? 0 }
  } finally {
    opened.close()
  }
}

function announce(input: BoardWatchLoopInput, decision: BoardWatchDecision): void {
  const at = iso(input.now())
  if (decision.announce === 'signed-out') input.log(`${at} signed out; ${RECORD_SIGN_IN_REMEDY}`)
  if (decision.action === 'reconnect' && decision.reason && decision.reason !== 'unauthorized')
    input.log(`${at} disconnected ${decision.reason}`)
  if (decision.action === 'exit' && decision.reason === 'newer-build')
    input.log(`${at} exiting for a newer build`)
}

async function requestPull(input: BoardWatchLoopInput, gate: PullGate): Promise<void> {
  if (gate.pulling) {
    gate.queued = true
    return
  }
  gate.pulling = true
  try {
    do {
      gate.queued = false
      const applied = await input.pull()
      input.log(`${iso(input.now())} pulled ${applied}`)
    } while (gate.queued)
  } finally {
    gate.pulling = false
  }
}

function consumeFrames(
  frames: BoardStreamFrame[],
  state: BoardWatchState,
  cursor: string,
  sawEvent: boolean,
): { state: BoardWatchState; sawEvent: boolean; pull: boolean } {
  let next = state
  let seen = sawEvent
  let pull = false
  for (const frame of frames) {
    if (frame.kind !== 'event') continue
    if (!seen) {
      seen = true
      next = decideBoardWatch(next, { kind: 'first-event' }, 0).state
    }
    if (boardWatchShouldPull({ reason: 'event', revision: frame.revision, cursor })) pull = true
  }
  return { state: next, sawEvent: seen, pull }
}

async function readOrWait(
  pending: { read: Promise<Uint8Array | null> | null },
  source: BoardWatchChunkSource,
  waitMs: number,
  wait: BoardWatchLoopInput['wait'],
  signal: AbortSignal,
): Promise<{ kind: 'chunk'; value: Uint8Array | null } | { kind: 'timer' } | { kind: 'aborted' }> {
  pending.read ??= source.read()
  const raced = await Promise.race([
    pending.read.then((value) => ({ kind: 'chunk' as const, value })),
    wait(waitMs, signal).then((result) =>
      result === 'aborted' ? ({ kind: 'aborted' as const } as const) : ({ kind: 'timer' as const } as const),
    ),
  ])
  if (raced.kind === 'chunk') pending.read = null
  return raced
}

async function holdStream(
  input: BoardWatchLoopInput,
  source: BoardWatchChunkSource,
  startState: BoardWatchState,
  gate: PullGate,
): Promise<{ state: BoardWatchState; decision: BoardWatchDecision }> {
  const decoder = new TextDecoder()
  const parser = createBoardStreamParser()
  const pending: { read: Promise<Uint8Array | null> | null } = { read: null }
  let lastByte = input.now()
  let lastSlow = input.now()
  let sawEvent = false
  let state = startState
  while (!input.signal.aborted) {
    if (input.readBuild() !== input.startedBuild) {
      const decision = decideBoardWatch(state, { kind: 'build-changed' }, 0)
      return { state: decision.state, decision }
    }
    const waitMs = Math.max(
      0,
      Math.min(
        BOARD_WATCH_SILENCE_MS - (input.now() - lastByte),
        BOARD_WATCH_SLOW_INTERVAL_MS - (input.now() - lastSlow),
      ),
    )
    const raced = await readOrWait(pending, source, waitMs, input.wait, input.signal)
    if (raced.kind === 'aborted') return { state, decision: { state, action: 'stay' } }
    if (raced.kind === 'timer') {
      if (input.now() - lastByte >= BOARD_WATCH_SILENCE_MS) {
        const decision = decideBoardWatch(state, { kind: 'silence' }, input.random())
        return { state: decision.state, decision }
      }
      lastSlow = input.now()
      await requestPull(input, gate)
      continue
    }
    if (raced.value === null) {
      const decision = decideBoardWatch(state, { kind: 'ended-normal' }, input.random())
      return { state: decision.state, decision }
    }
    lastByte = input.now()
    const consumed = consumeFrames(
      parser.push(decoder.decode(raced.value, { stream: true })),
      state,
      input.readCursor(),
      sawEvent,
    )
    state = consumed.state
    sawEvent = consumed.sawEvent
    if (consumed.pull) await requestPull(input, gate)
  }
  return { state, decision: { state, action: 'stay' } }
}

function sourceFromBody(body: ReadableStream<Uint8Array>): BoardWatchChunkSource {
  const reader = body.getReader()
  return {
    async read() {
      const result = await reader.read()
      return result.done ? null : (result.value ?? new Uint8Array())
    },
  }
}

async function openProductionStream(signal: AbortSignal): Promise<BoardWatchOpen> {
  const connection = new AbortController()
  const stop = () => connection.abort()
  signal.addEventListener('abort', stop)
  const drop = () => signal.removeEventListener('abort', stop)
  try {
    const response = await recordApiClient().openBoardStream(connection.signal)
    if (response.status === 401 || response.status === 403) {
      drop()
      return { kind: 'unauthorized' }
    }
    if (!response.ok || !response.body) {
      drop()
      return { kind: 'error' }
    }
    return {
      kind: 'stream',
      source: sourceFromBody(response.body),
      close: () => {
        drop()
        connection.abort()
      },
    }
  } catch (error) {
    drop()
    if (signal.aborted) return { kind: 'error' }
    const message = error instanceof Error ? error.message : String(error)
    return { kind: message.includes(RECORD_SIGN_IN_REMEDY) ? 'unauthorized' : 'error' }
  }
}

async function pullProduction(): Promise<number> {
  let applied = 0
  const inner = recordApiClient()
  await refreshHostedBoard({
    budgetMs: BOARD_WATCH_REFRESH_BUDGET_MS,
    client: {
      ...inner,
      listBoardChanges: async (query) => {
        const page = await inner.listBoardChanges(query)
        applied += page.items.length
        return page
      },
    },
  })
  return applied
}

export async function watchHostedBoard(): Promise<number> {
  enableSchemaReload(() => {})
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    const startedBuild = installationVersionText(import.meta.dir, process.env)
    return await runBoardWatchLoop({
      now: Date.now,
      wait: waitFor,
      openStream: openProductionStream,
      pull: pullProduction,
      readCursor: () => hostedBoardCursor(),
      readBuild: () => installationVersionText(import.meta.dir, process.env),
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
