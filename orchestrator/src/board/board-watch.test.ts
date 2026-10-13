import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BOARD_STREAM_EVENT } from '../record/record-board-stream.ts'
import {
  BOARD_WATCH_ERROR_DETAIL_MAX,
  BOARD_WATCH_UNCONFIGURED_REMEDY,
  type BoardWatchLoopInput,
  type BoardWatchOpen,
  type BoardWatchPullResult,
  runBoardWatchLoop,
} from './board-watch.ts'
import {
  BOARD_WATCH_BACKOFF_BASE_MS,
  BOARD_WATCH_BUILD_CHECK_MS,
  BOARD_WATCH_NEWER_BUILD_EXIT_CODE,
  BOARD_WATCH_SILENCE_MS,
  BOARD_WATCH_SLOW_INTERVAL_MS,
  type BoardWatchDecision,
  type BoardWatchEvent,
  type BoardWatchState,
  decideBoardWatch,
} from './board-watch-decision.ts'
import { BOARD_WATCH_FRAME_BUFFER_MAX } from './board-watch-frames.ts'

const eventFrame = (revision: string) =>
  `id: ${revision}\nevent: ${BOARD_STREAM_EVENT.name}\ndata: ${JSON.stringify({ revision })}\n\n`

const abortError = () => new DOMException('The operation was aborted.', 'AbortError')

class ScriptedSource {
  #queue: Uint8Array[] = []
  #failures: unknown[] = []
  #wait: {
    resolve: (value: Uint8Array | null) => void
    reject: (error: unknown) => void
  } | null = null
  #aborted = false

  constructor(signal?: AbortSignal) {
    if (signal?.aborted) this.#abort()
    else signal?.addEventListener('abort', () => this.#abort(), { once: true })
  }

  push(text: string) {
    if (this.#aborted) return
    this.#deliver(new TextEncoder().encode(text))
  }
  close() {
    this.#abort()
  }
  reject(error: unknown) {
    if (this.#aborted) return
    if (this.#wait) {
      const wait = this.#wait
      this.#wait = null
      wait.reject(error)
      return
    }
    this.#failures.push(error)
  }
  #abort() {
    if (this.#aborted) return
    this.#aborted = true
    if (!this.#wait) return
    const wait = this.#wait
    this.#wait = null
    wait.reject(abortError())
  }
  #deliver(value: Uint8Array) {
    if (this.#wait) {
      const wait = this.#wait
      this.#wait = null
      wait.resolve(value)
      return
    }
    this.#queue.push(value)
  }
  read() {
    if (this.#aborted) return Promise.reject(abortError())
    if (this.#failures.length > 0) return Promise.reject(this.#failures.shift())
    if (this.#queue.length > 0) return Promise.resolve(this.#queue.shift()!)
    return new Promise<Uint8Array | null>((resolve, reject) => {
      this.#wait = { resolve, reject }
    })
  }
}

class ManualClock {
  nowMs = Date.parse('2026-10-13T12:00:00.000Z')
  #seq = 1
  #timers = new Map<
    number,
    {
      due: number
      resolve: (value: 'elapsed' | 'aborted') => void
      signal: AbortSignal
      onAbort: () => void
    }
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
        if (timer.due <= target && (next === null || timer.due < next.due))
          next = { id, due: timer.due }
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
    pullResult?: BoardWatchPullResult
    pullResults?: BoardWatchPullResult[]
  } = {},
) {
  const clock = new ManualClock()
  const ac = new AbortController()
  const logs: string[] = []
  const pulls: Array<() => void> = []
  const decisions: BoardWatchDecision[] = []
  let cursor = '0'
  let build: string | null =
    overrides.startedBuild === undefined ? 'build-a' : overrides.startedBuild
  let source = new ScriptedSource()
  let opens = 0
  let pullCount = 0
  let buildReads = 0
  const hangingPull = Boolean(overrides.hangingPull)
  const openKind = overrides.openKind
  const decide: NonNullable<BoardWatchLoopInput['decide']> = (state, event, jitter) => {
    const decision = (overrides.decide ?? decideBoardWatch)(state, event, jitter)
    decisions.push(decision)
    return decision
  }
  const input: BoardWatchLoopInput = {
    now: () => clock.now(),
    wait: clock.wait,
    openStream: async (signal) => {
      opens += 1
      if (openKind === 'unauthorized') return { kind: 'unauthorized' }
      if (openKind) return { kind: 'error', reason: 'denied' }
      const current = new ScriptedSource(signal)
      source = current
      return { kind: 'stream', source: current, close: () => current.close() }
    },
    pull:
      overrides.pull ??
      (async () => {
        pullCount += 1
        if (hangingPull) {
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => reject(abortError())
            if (ac.signal.aborted) {
              onAbort()
              return
            }
            ac.signal.addEventListener('abort', onAbort, { once: true })
            pulls.push(() => {
              ac.signal.removeEventListener('abort', onAbort)
              resolve()
            })
          })
          return { kind: 'ok', applied: 1 }
        }
        if (overrides.pullResults && overrides.pullResults.length > 0)
          return overrides.pullResults.shift()!
        return overrides.pullResult ?? { kind: 'ok', applied: 1 }
      }),
    readCursor: () => cursor,
    readBuild: () => {
      buildReads += 1
      return build
    },
    startedBuild: overrides.startedBuild === undefined ? 'build-a' : overrides.startedBuild,
    configured: overrides.configured ?? true,
    random: () => 1,
    log: (line) => logs.push(line),
    signal: ac.signal,
    decide,
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
    buildReads: () => buildReads,
    decisions: () => decisions,
    releasePull: () => pulls.shift()?.(),
    setCursor: (value: string) => {
      cursor = value
    },
    setBuild: (value: string | null) => {
      build = value
    },
    done,
  }
}

const ended = (line: string, suffix: string) => line.endsWith(suffix)
const loggedAbort = (logs: string[]) => logs.some((line) => /abort/i.test(line))
const connectionResetError = () =>
  new Error(
    'ECONNRESET: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()',
  )

test('an unconfigured machine prints the remedy and exits zero', async () => {
  const run = await startLoop({ configured: false })
  expect(await run.done).toBe(0)
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

test('a pull that applied nothing prints nothing', async () => {
  const run = await startLoop({ pullResult: { kind: 'ok', applied: 0 } })
  expect(run.pullCount()).toBe(1)
  expect(run.logs.some((line) => line.includes('pulled'))).toBe(false)
  run.ac.abort()
  await run.done
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
  expect(run.pullCount()).toBe(1)
  await run.clock.advance(BOARD_WATCH_BACKOFF_BASE_MS)
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

async function advancePastBuildCheck(run: Awaited<ReturnType<typeof startLoop>>) {
  const deadline = run.clock.nowMs + BOARD_WATCH_BUILD_CHECK_MS
  while (run.clock.nowMs < deadline) {
    run.source().push(': heartbeat\n\n')
    await run.clock.flush()
    const step = Math.min(BOARD_WATCH_SILENCE_MS / 2, deadline - run.clock.nowMs)
    await run.clock.advance(step)
  }
  await run.clock.flush()
}

test('a changed build exits with the named unsuccessful code after the check interval', async () => {
  const run = await startLoop()
  const readsAtConnect = run.buildReads()
  run.setBuild('build-b')
  await advancePastBuildCheck(run)
  expect(run.buildReads()).toBeGreaterThan(readsAtConnect)
  expect(await run.done).toBe(BOARD_WATCH_NEWER_BUILD_EXIT_CODE)
  expect(run.logs.some((line) => ended(line, ' exiting for a newer build'))).toBe(true)
})

test('an unreadable commit then a restored one does not exit; a later concrete one does', async () => {
  const run = await startLoop({ startedBuild: null })
  run.setBuild('build-a')
  await advancePastBuildCheck(run)
  expect(run.logs.some((line) => line.includes('exiting for a newer build'))).toBe(false)
  run.setBuild(null)
  await advancePastBuildCheck(run)
  expect(run.logs.some((line) => line.includes('exiting for a newer build'))).toBe(false)
  run.setBuild('build-a')
  await advancePastBuildCheck(run)
  expect(run.logs.some((line) => line.includes('exiting for a newer build'))).toBe(false)
  run.setBuild('build-b')
  await advancePastBuildCheck(run)
  expect(await run.done).toBe(BOARD_WATCH_NEWER_BUILD_EXIT_CODE)
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

test('an API refusal is logged and retried without ending the stream', async () => {
  const run = await startLoop({
    pullResults: [
      { kind: 'failed', reason: 'record API 500' },
      { kind: 'ok', applied: 2 },
    ],
  })
  expect(run.logs.some((line) => line.includes('pull failed record API 500'))).toBe(true)
  expect(run.opens()).toBe(1)
  expect(run.pullCount()).toBe(1)
  await run.clock.advance(BOARD_WATCH_BACKOFF_BASE_MS)
  await run.clock.flush()
  expect(run.pullCount()).toBe(2)
  expect(run.opens()).toBe(1)
  expect(run.logs.some((line) => ended(line, ' pulled 2'))).toBe(true)
  run.ac.abort()
  await run.done
})

test('an incomplete pull does not run before backoff and resets that delay on progress', async () => {
  const run = await startLoop({
    pullResults: [
      { kind: 'incomplete', applied: 0 },
      { kind: 'incomplete', applied: 3 },
      { kind: 'incomplete', applied: 0 },
      { kind: 'ok', applied: 1 },
    ],
  })
  await run.clock.flush()
  expect(run.pullCount()).toBe(1)
  await run.clock.advance(BOARD_WATCH_BACKOFF_BASE_MS - 1)
  await run.clock.flush()
  expect(run.pullCount()).toBe(1)
  await run.clock.advance(1)
  await run.clock.flush()
  expect(run.pullCount()).toBe(2)
  expect(run.logs.some((line) => ended(line, ' pulled 3'))).toBe(true)
  await run.clock.advance(BOARD_WATCH_BACKOFF_BASE_MS - 1)
  await run.clock.flush()
  expect(run.pullCount()).toBe(2)
  await run.clock.advance(1)
  await run.clock.flush()
  expect(run.pullCount()).toBe(3)
  await run.clock.advance(BOARD_WATCH_BACKOFF_BASE_MS)
  await run.clock.flush()
  expect(run.pullCount()).toBe(3)
  await run.clock.advance(BOARD_WATCH_BACKOFF_BASE_MS)
  await run.clock.flush()
  expect(run.pullCount()).toBe(4)
  expect(run.logs.some((line) => ended(line, ' pulled 1'))).toBe(true)
  expect(run.opens()).toBe(1)
  run.ac.abort()
  await run.done
})

test('the launchd template restarts only after an unsuccessful exit', () => {
  const text = readFileSync(
    join(import.meta.dir, '../../../ops/launchd/com.user.orch-board-watch.plist.template'),
    'utf8',
  )
  expect(text).toMatch(
    /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/,
  )
})

test('a stop signal during a pending read exits zero and prints nothing for the abort', async () => {
  const run = await startLoop()
  run.ac.abort()
  expect(await run.done).toBe(0)
  await run.clock.flush()
  expect(loggedAbort(run.logs)).toBe(false)
})

test('a stop signal during a pull in flight exits zero and prints nothing for the abort', async () => {
  const run = await startLoop({ hangingPull: true })
  expect(run.pullCount()).toBe(1)
  run.ac.abort()
  expect(await run.done).toBe(0)
  await run.clock.flush()
  expect(loggedAbort(run.logs)).toBe(false)
})

test('a pull abort that is not the watcher shutdown is still a failed pull', async () => {
  const run = await startLoop({
    pull: async () => {
      throw abortError()
    },
  })
  expect(run.logs.some((line) => line.includes('pull failed The operation was aborted.'))).toBe(
    true,
  )
  expect(run.opens()).toBe(1)
  run.ac.abort()
  expect(await run.done).toBe(0)
})

test('a rejected stream read after an event logs one error and reconnects', async () => {
  const run = await startLoop()
  run.source().push(eventFrame('0'))
  await run.clock.flush()
  run.source().reject(connectionResetError())
  await run.clock.flush()
  await run.clock.flush()
  expect(
    run.logs.filter((line) => line.includes(' disconnected error Error: ECONNRESET:')),
  ).toHaveLength(1)
  expect(run.opens()).toBe(1)
  await run.clock.advance(BOARD_WATCH_BACKOFF_BASE_MS)
  await run.clock.flush()
  expect(run.opens()).toBe(2)
  run.ac.abort()
  expect(await run.done).toBe(0)
})

test('a rejected stream read while a pull is in flight logs one error and reconnects', async () => {
  const run = await startLoop({ hangingPull: true })
  expect(run.pullCount()).toBe(1)
  run.source().push(eventFrame('0'))
  await run.clock.flush()
  run.source().reject(connectionResetError())
  await run.clock.flush()
  await run.clock.flush()
  expect(
    run.logs.filter((line) => line.includes(' disconnected error Error: ECONNRESET:')),
  ).toHaveLength(1)
  expect(run.opens()).toBe(1)
  await run.clock.advance(BOARD_WATCH_BACKOFF_BASE_MS)
  await run.clock.flush()
  expect(run.opens()).toBe(2)
  expect(run.pullCount()).toBe(1)
  run.releasePull()
  await run.clock.flush()
  expect(run.pullCount()).toBe(2)
  run.releasePull()
  run.ac.abort()
  expect(await run.done).toBe(0)
})

test('an error detail is one bounded line', async () => {
  const run = await startLoop()
  run.source().reject(new TypeError(`${'x'.repeat(BOARD_WATCH_ERROR_DETAIL_MAX * 2)}\nnot logged`))
  await run.clock.flush()
  await run.clock.flush()
  const line = run.logs.find((candidate) => candidate.includes(' disconnected error '))!
  const detail = line.split(' disconnected error ')[1] ?? ''
  expect(detail).toHaveLength(BOARD_WATCH_ERROR_DETAIL_MAX)
  expect(detail.startsWith('TypeError: ')).toBe(true)
  expect(detail.includes('\n')).toBe(false)
  expect(detail.includes('not logged')).toBe(false)
  run.ac.abort()
  expect(await run.done).toBe(0)
})

test('a failing pull is announced once until the reason changes or it succeeds', async () => {
  const run = await startLoop({
    pullResults: [
      { kind: 'failed', reason: 'record API 500' },
      { kind: 'failed', reason: 'record API 500' },
      { kind: 'failed', reason: 'offline' },
      { kind: 'ok', applied: 2 },
    ],
  })
  expect(run.logs.filter((line) => line.includes('pull failed')).length).toBe(1)
  expect(run.logs.some((line) => line.includes('pull failed record API 500'))).toBe(true)
  await run.clock.advance(BOARD_WATCH_BACKOFF_BASE_MS)
  await run.clock.flush()
  expect(run.pullCount()).toBe(2)
  expect(run.logs.filter((line) => line.includes('pull failed')).length).toBe(1)
  await run.clock.advance(BOARD_WATCH_BACKOFF_BASE_MS * 2)
  await run.clock.flush()
  expect(run.pullCount()).toBe(3)
  expect(run.logs.filter((line) => line.includes('pull failed')).length).toBe(2)
  expect(run.logs.some((line) => line.includes('pull failed offline'))).toBe(true)
  await run.clock.advance(BOARD_WATCH_BACKOFF_BASE_MS * 4)
  await run.clock.flush()
  expect(run.pullCount()).toBe(4)
  expect(run.logs.filter((line) => ended(line, ' pulling again')).length).toBe(1)
  expect(run.logs.some((line) => ended(line, ' pulled 2'))).toBe(true)
  run.ac.abort()
  await run.done
})

test('the loop takes no action the decision did not return', async () => {
  const decide = (
    state: BoardWatchState,
    event: BoardWatchEvent,
    jitter: number,
  ): BoardWatchDecision => {
    const real = decideBoardWatch(state, event, jitter)
    return { ...real, pull: false, announce: null, action: 'stay', exitCode: null, delayMs: 0 }
  }
  const run = await startLoop({ decide })
  run.source().push(eventFrame('9'))
  await run.clock.flush()
  const deadline = run.clock.nowMs + BOARD_WATCH_SLOW_INTERVAL_MS
  while (run.clock.nowMs < deadline) {
    run.source().push(': heartbeat\n\n')
    await run.clock.flush()
    const step = Math.min(BOARD_WATCH_SILENCE_MS / 2, deadline - run.clock.nowMs)
    await run.clock.advance(step)
  }
  await run.clock.flush()
  expect(run.pullCount()).toBe(0)
  expect(run.logs).toEqual([])
  expect(run.opens()).toBe(1)
  run.ac.abort()
  await run.done
})

test('a throwing pull is handled and does not end the process or the stream', async () => {
  let calls = 0
  const run = await startLoop({
    pull: async () => {
      calls += 1
      if (calls === 1) throw new Error('boom')
      return { kind: 'ok', applied: 0 }
    },
  })
  expect(run.logs.some((line) => line.includes('pull failed boom'))).toBe(true)
  expect(run.opens()).toBe(1)
  await run.clock.advance(BOARD_WATCH_BACKOFF_BASE_MS)
  await run.clock.flush()
  expect(calls).toBe(2)
  expect(run.opens()).toBe(1)
  run.ac.abort()
  expect(await run.done).toBe(0)
})

test('an oversized frame reconnects on the error path', async () => {
  const run = await startLoop()
  run.source().push('x'.repeat(BOARD_WATCH_FRAME_BUFFER_MAX + 1))
  await run.clock.flush()
  expect(run.logs.some((line) => line.includes(' disconnected error Error: '))).toBe(true)
  await run.clock.advance(BOARD_WATCH_BACKOFF_BASE_MS)
  await run.clock.flush()
  expect(run.opens()).toBe(2)
  run.ac.abort()
  await run.done
})
