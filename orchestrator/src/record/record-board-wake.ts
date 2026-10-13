// concern: record-board-wake
/** Owns the process-wide Postgres wake adapter. Must not know HTTP or board visibility. */

import { SQL } from 'bun'
import { BOARD_MESSAGE_NOTIFY_CHANNEL } from '../../../shared/record/board-stream.ts'

export const BOARD_WAKE_SAFETY_INTERVAL_MS = 30_000

export type BoardWakeSource = {
  subscribe(listener: () => void): () => void
}

type BoardWakeClock = {
  setInterval(callback: () => void, milliseconds: number): ReturnType<typeof setInterval>
  clearInterval(timer: ReturnType<typeof setInterval>): void
}

type BoardListener = {
  listen(
    channel: string,
    onnotify: (payload: string) => void,
    onlisten: () => void,
  ): Promise<{ unlisten(): Promise<void> }>
  close(): Promise<void>
}

export async function createBoardWakeSource(
  recordUrl: string,
  options: {
    listener?: BoardListener
    clock?: BoardWakeClock
  } = {},
): Promise<BoardWakeSource & { close(): Promise<void> }> {
  const listeners = new Set<() => void>()
  const wake = () => {
    for (const listener of listeners) listener()
  }
  const clock = options.clock ?? globalThis
  const client = options.listener ?? new SQL(recordUrl)
  const subscription = await client.listen(BOARD_MESSAGE_NOTIFY_CHANNEL, wake, wake)
  const safetyTimer = clock.setInterval(wake, BOARD_WAKE_SAFETY_INTERVAL_MS)
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async close() {
      clock.clearInterval(safetyTimer)
      await subscription.unlisten()
      await client.close()
    },
  }
}
