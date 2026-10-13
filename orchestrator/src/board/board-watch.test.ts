import { expect, test } from 'bun:test'
import { BOARD_STREAM_EVENT } from '../record/record-board-stream.ts'
import {
  BOARD_WATCH_BACKOFF_BASE_MS,
  BOARD_WATCH_SILENCE_MS,
  BOARD_WATCH_SLOW_INTERVAL_MS,
} from './board-watch-decision.ts'
import {
  BOARD_WATCH_UNCONFIGURED_REMEDY,
  type BoardWatchLoopInput,
  type BoardWatchOpen,
  runBoardWatchLoop,
} from './board-watch.ts'

const eventFrame = (revision: string) =>
  `id: ${revision}\nevent: ${BOARD_STREAM_EVENT.name}\ndata: ${JSON.stringify({ revision })}\n\n`

class ScriptedSource {
  #queue: Array<Uint8Array | null> = []
  #wait: ((value: Uint8Array | null) => void) | null = null

  push(text: string) {
    this.#deliver(new TextEncoder().encode(text))
  }
  close() {
    this.#deliver(null)
  }
  #deliver(value: Uint8Array | null) {
    if (this.#wait) {
      const wait = this.#wait
      this.#wait = null
      wait(value)
      return
    }
    this.#queue.push(value)
  }
  read() {
    if (this.#queue.length > 0) return Promise.resolve(this.#queue.shift()!)
    return new Promise<Uint8Array | null>((resolve) => {
      this.#wait = resolve
    })
  }
}

class ManualClock {
  nowMs = Date.parse('2026-10-13T12:00:00.000Z')
  #seq = 1
  #timers = new Map<
    number,
    { due: number; resolve: (value: 'elapsed' | 'aborted') => void; signal: AbortSignal; onAbort: () => void }
  >()

  now() {
    return this.nowMs
  }

  wait = (ms: number, signal: AbortSignal): Promise<'elapsed' | 'aborted'> => {
    if (signal.aborted) return Promise.resolve('aborted')
    if (ms <= 0) return Promise.resolve('elapsed')
    return new Promise((resolve) => {
      const id = this.#seq++
      const onAbort = () => {
        this.#timers.delete(id)
        resolve('aborted')
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.#timers.set(id, { due: this.nowMs + ms, resolve, signal, onAbort })
    })
  }

  async flush() {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  }

  async advance(ms: number) {
    const target = this.nowMs + ms
    for (;;) {
      await this.flush()
      let next: { id: number; due: number } | null = null
      for (const [id, timer] of this.#timers) {
        if (timer.due <= target && (next === null || timer.due < next.due)) next = { id, due: timer.due }
      }
      if (!next) {
        this.nowMs = target
        return
      }
      const timer = this.#timers.get(next.id)
      if (!timer) return
      this.#timers.delete(next.id)
      this.nowMs = timer.due
      timer.signal.removeEventListener('abort', timer.onAbort)
      timer.resolve('elapsed')
    }
  }
}

async function startLoop(
  overrides: Partial<BoardWatchLoopInput> & {
    hangingPull?: boolean
    openKind?: Exclude<BoardWatchOpen['kind'], 'stream'>
  } = {},
) {
  const clock = new ManualClock()
  const ac = new AbortController()
  const logs: string[] = []
  const pulls: Array<() => void> = []
  let cursor = '0'
  let build = 'build-a'
  let source = new ScriptedSource()
  let opens = 0
  let pullCount = 0
  const hangingPull = Boolean(overrides.hangingPull)
  const openKind = overrides.openKind
  const input: BoardWatchLoopInput = {
    now: () => clock.now(),
    wait: clock.wait,
    openStream: async () => {
      opens += 1
      if (openKind) return { kind: openKind }
      const current = new ScriptedSource()
      source = current
      return { kind: 'stream', source: current, close: () => current.close() }
    },
    pull: async () => {
      pullCount += 1
      if (!hangingPull) return 1
      await new Promise<void>((resolve) => pulls.push(resolve))
      return 1
    },
    readCursor: () => cursor,
    readBuild: () => build,
    startedBuild: 'build-a',
    configured: overrides.configured ?? true,
    random: () => 1,
    log: (line) => logs.push(line),
    signal: ac.signal,
  }
  const done = runBoardWatchLoop(input)
  await clock.flush()
  return {
    clock,
    ac,
    logs,
    source: () => source,
    opens: () => opens,
    pullCount: () => pullCount,
    releasePull: () => pulls.shift()?.(),
    setCursor: (value: string) => {
      cursor = value
    },
    setBuild: (value: string) => {
      build = value
    },
    done,
  }
}

const ended = (line: string, suffix: string) => line.endsWith(suffix)

test('an unconfigured machine exits with the remedy', async () => {
  const run = await startLoop({ configured: false })
  expect(await run.done).toBe(1)
  expect(run.logs.some((line) => line.includes(BOARD_WATCH_UNCONFIGURED_REMEDY))).toBe(true)
  expect(run.pullCount()).toBe(0)
})

test('a successful connect pulls', async () => {
  const run = await startLoop()
  expect(run.pullCount()).toBe(1)
  expect(run.logs.some((line) => ended(line, ' connected'))).toBe(true)
  expect(run.logs.some((line) => ended(line, ' pulled 1'))).toBe(true)
  run.ac.abort()
  expect(await run.done).toBe(0)
})

test('an event ahead of the cursor pulls; one at or behind it does not', async () => {
  const run = await startLoop()
  expect(run.pullCount()).toBe(1)
  run.source().push(eventFrame('2'))
  await run.clock.flush()
  expect(run.pullCount()).toBe(2)
  run.setCursor('5')
  run.source().push(eventFrame('5'))
  run.source().push(eventFrame('4'))
  await run.clock.flush()
  expect(run.pullCount()).toBe(2)
  run.ac.abort()
  await run.done
})

test('reasons that arrive during a pull collapse into one further pull', async () => {
  const run = await startLoop({ hangingPull: true })
  expect(run.pullCount()).toBe(1)
  run.source().push(eventFrame('9'))
  await run.clock.flush()
  expect(run.pullCount()).toBe(1)
  run.releasePull()
  await run.clock.flush()
  expect(run.pullCount()).toBe(2)
  run.releasePull()
  run.ac.abort()
  await run.done
})

test('the slow timer pulls while connected', async () => {
  const run = await startLoop()
  expect(run.pullCount()).toBe(1)
  const deadline = run.clock.nowMs + BOARD_WATCH_SLOW_INTERVAL_MS
  while (run.clock.nowMs < deadline) {
    run.source().push(': heartbeat\n\n')
    await run.clock.flush()
    const step = Math.min(BOARD_WATCH_SILENCE_MS / 2, deadline - run.clock.nowMs)
    await run.clock.advance(step)
  }
  await run.clock.flush()
  expect(run.pullCount()).toBe(2)
  run.ac.abort()
  await run.done
})

test('silence reconnects after backoff', async () => {
  const run = await startLoop()
  expect(run.opens()).toBe(1)
  await run.clock.advance(BOARD_WATCH_SILENCE_MS)
  await run.clock.flush()
  expect(run.logs.some((line) => ended(line, ' disconnected silence'))).toBe(true)
  expect(run.opens()).toBe(1)
  await run.clock.advance(BOARD_WATCH_BACKOFF_BASE_MS)
  await run.clock.flush()
  expect(run.opens()).toBe(2)
  run.ac.abort()
  await run.done
})

test('a changed build exits cleanly', async () => {
  const run = await startLoop()
  run.setBuild('build-b')
  await run.clock.advance(BOARD_WATCH_SLOW_INTERVAL_MS)
  await run.clock.flush()
  expect(await run.done).toBe(0)
  expect(run.logs.some((line) => ended(line, ' exiting for a newer build'))).toBe(true)
})

test('unauthorized retries on the slowest step and says the sign-in remedy once', async () => {
  const run = await startLoop({ openKind: 'unauthorized' })
  expect(run.logs.filter((line) => line.includes('signed out')).length).toBe(1)
  expect(run.pullCount()).toBe(0)
  await run.clock.advance(60_000)
  await run.clock.flush()
  expect(run.opens()).toBe(2)
  expect(run.logs.filter((line) => line.includes('signed out')).length).toBe(1)
  run.ac.abort()
  await run.done
})
