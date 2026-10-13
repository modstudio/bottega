import { expect, test } from 'bun:test'
import { BOARD_STREAM_EVENT } from '../../../shared/record/board-stream.ts'
import {
  BOARD_STREAM_HEARTBEAT_INTERVAL_MS,
  BOARD_STREAM_MAX_LIFETIME_MS,
  type BoardStreamClock,
  boardStreamAdvance,
  boardStreamResponse,
} from './record-board-stream.ts'
import type { BoardWakeSource } from './record-board-wake.ts'

class FakeClock implements BoardStreamClock {
  intervals = new Map<number, () => void>()
  timeouts = new Map<number, () => void>()
  #next = 1

  setInterval(callback: () => void, milliseconds: number) {
    expect(milliseconds).toBe(BOARD_STREAM_HEARTBEAT_INTERVAL_MS)
    const id = this.#next++
    this.intervals.set(id, callback)
    return id as unknown as ReturnType<typeof setInterval>
  }
  clearInterval(timer: ReturnType<typeof setInterval>) {
    this.intervals.delete(timer as unknown as number)
  }
  setTimeout(callback: () => void, milliseconds: number) {
    expect(milliseconds).toBe(BOARD_STREAM_MAX_LIFETIME_MS)
    const id = this.#next++
    this.timeouts.set(id, callback)
    return id as unknown as ReturnType<typeof setTimeout>
  }
  clearTimeout(timer: ReturnType<typeof setTimeout>) {
    this.timeouts.delete(timer as unknown as number)
  }
}

class FakeWakeSource implements BoardWakeSource {
  listeners = new Set<() => void>()
  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  wake() {
    for (const listener of this.listeners) listener()
  }
}

const tenant = {
  url: 'postgres://record.test/record',
  userId: 'user-a',
  spaceId: 'space-a',
  spaceIds: ['space-a'],
}
const decode = (value: Uint8Array | undefined) => new TextDecoder().decode(value)
const settle = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

test('board stream advance emits only a strictly newer visible revision', () => {
  expect(boardStreamAdvance(null, '0')).toEqual({ send: true, lastSent: '0' })
  expect(boardStreamAdvance('9', '9')).toEqual({ send: false, lastSent: '9' })
  expect(boardStreamAdvance('10', '9')).toEqual({ send: false, lastSent: '10' })
  expect(boardStreamAdvance('9', '10')).toEqual({ send: true, lastSent: '10' })
})

test('board stream emits the visible head, advances on wakes, and collapses concurrent wakes', async () => {
  const clock = new FakeClock()
  const wakes = new FakeWakeSource()
  const heads = ['7']
  let release: ((value: string) => void) | undefined
  let reads = 0
  const response = boardStreamResponse({
    tenant,
    wakeSource: wakes,
    signal: new AbortController().signal,
    clock,
    readHead: async () => {
      reads++
      const head = heads.shift()
      if (head !== undefined) return head
      return new Promise<string>((resolve) => {
        release = resolve
      })
    },
  })
  expect(response.headers.get('content-type')).toBe('text/event-stream')
  const reader = response.body!.getReader()
  const first = decode((await reader.read()).value)
  expect(first).toBe(`id: 7\nevent: ${BOARD_STREAM_EVENT.name}\ndata: {"revision":"7"}\n\n`)

  wakes.wake()
  await settle()
  wakes.wake()
  wakes.wake()
  release?.('8')
  const advanced = decode((await reader.read()).value)
  expect(advanced).toContain('id: 8')
  await settle()
  expect(reads).toBe(3)
  await reader.cancel()
})

test('board stream suppresses an unchanged wake and emits heartbeat comments', async () => {
  const clock = new FakeClock()
  const wakes = new FakeWakeSource()
  let reads = 0
  const response = boardStreamResponse({
    tenant,
    wakeSource: wakes,
    signal: new AbortController().signal,
    clock,
    readHead: async () => {
      reads++
      return '3'
    },
  })
  const reader = response.body!.getReader()
  await reader.read()
  wakes.wake()
  await settle()
  expect(reads).toBe(2)
  clock.intervals.values().next().value?.()
  expect(decode((await reader.read()).value)).toBe(': heartbeat\n\n')
  await reader.cancel()
})

test('board stream ends at maximum lifetime and cleans up when its client leaves', async () => {
  const clock = new FakeClock()
  const wakes = new FakeWakeSource()
  const response = boardStreamResponse({
    tenant,
    wakeSource: wakes,
    signal: new AbortController().signal,
    clock,
    readHead: async () => '0',
  })
  const reader = response.body!.getReader()
  await reader.read()
  expect(wakes.listeners.size).toBe(1)
  clock.timeouts.values().next().value?.()
  expect((await reader.read()).done).toBe(true)
  expect(wakes.listeners.size).toBe(0)
  expect(clock.intervals.size).toBe(0)

  const second = boardStreamResponse({
    tenant,
    wakeSource: wakes,
    signal: new AbortController().signal,
    clock,
    readHead: async () => '0',
  })
  const secondReader = second.body!.getReader()
  await secondReader.read()
  await secondReader.cancel()
  expect(wakes.listeners.size).toBe(0)
  expect(clock.intervals.size).toBe(0)
  expect(clock.timeouts.size).toBe(0)
})
