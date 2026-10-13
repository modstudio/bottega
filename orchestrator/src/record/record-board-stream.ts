// concern: record-board-stream
/** Owns board stream policy and streaming. Must not know SQL, authentication, or local stores. */

import {
  BOARD_STREAM_EVENT,
  type BoardStreamEventData,
} from '../../../shared/record/board-stream.ts'
import type { BoardTenant } from './record-board-tx.ts'
import type { BoardWakeSource } from './record-board-wake.ts'

export const BOARD_STREAM_HEARTBEAT_INTERVAL_MS = 20_000
export const BOARD_STREAM_MAX_LIFETIME_MS = 15 * 60_000

export type BoardStreamClock = {
  setInterval(callback: () => void, milliseconds: number): ReturnType<typeof setInterval>
  clearInterval(timer: ReturnType<typeof setInterval>): void
  setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>
  clearTimeout(timer: ReturnType<typeof setTimeout>): void
}

/** Decides whether a visible head advances one caller's stream. */
export function boardStreamAdvance(lastSent: string | null, visibleHead: string) {
  const advances = lastSent === null || BigInt(visibleHead) > BigInt(lastSent)
  return { send: advances, lastSent: advances ? visibleHead : lastSent }
}

function event(revision: string): string {
  const data: BoardStreamEventData = { revision }
  return `id: ${revision}\nevent: ${BOARD_STREAM_EVENT.name}\ndata: ${JSON.stringify(data)}\n\n`
}

export function boardStreamResponse(input: {
  tenant: BoardTenant
  wakeSource: BoardWakeSource
  readHead(tenant: BoardTenant): Promise<string>
  signal: AbortSignal
  clock?: BoardStreamClock
}): Response {
  const clock = input.clock ?? globalThis
  const encoder = new TextEncoder()
  let cleanup: () => void = () => undefined
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      let checking = false
      let pending = false
      let lastSent: string | null = null
      let unsubscribe: () => void = () => undefined
      let heartbeat: ReturnType<typeof setInterval>
      let lifetime: ReturnType<typeof setTimeout>

      const dispose = () => {
        if (closed) return
        closed = true
        unsubscribe()
        clock.clearInterval(heartbeat)
        clock.clearTimeout(lifetime)
        input.signal.removeEventListener('abort', dispose)
      }
      const close = () => {
        if (closed) return
        dispose()
        controller.close()
      }
      const check = async () => {
        if (closed) return
        if (checking) {
          pending = true
          return
        }
        checking = true
        try {
          do {
            pending = false
            const visibleHead = await input.readHead(input.tenant)
            if (closed) return
            const decision = boardStreamAdvance(lastSent, visibleHead)
            lastSent = decision.lastSent
            if (decision.send) controller.enqueue(encoder.encode(event(visibleHead)))
          } while (pending && !closed)
        } catch (error) {
          if (!closed) {
            controller.error(error)
            dispose()
          }
        } finally {
          checking = false
        }
      }

      unsubscribe = input.wakeSource.subscribe(() => void check())
      heartbeat = clock.setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(': heartbeat\n\n'))
      }, BOARD_STREAM_HEARTBEAT_INTERVAL_MS)
      lifetime = clock.setTimeout(close, BOARD_STREAM_MAX_LIFETIME_MS)
      input.signal.addEventListener('abort', dispose, { once: true })
      cleanup = dispose
      void check()
    },
    cancel() {
      cleanup()
    },
  })
  return new Response(body, {
    headers: {
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'content-type': 'text/event-stream',
    },
  })
}
