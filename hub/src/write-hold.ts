import type { StoreWriteHoldEntry } from '../../shared/store-write-hold-log.ts'

const WRITE_HOLD_BURST_GAP_MS = 5
const WRITE_HOLD_LOG_MS = 1_000
const WRITE_HOLD_CALLER_MS = 50

export type FinishedWriteTransaction = {
  beganMs: number
  endedMs: number
  caller: string | null
}

export type WriteHoldWindow = {
  beganMs: number
  endedMs: number
  longestMs: number
  transactions: number
  caller: string | null
}

function openedWindow(transaction: FinishedWriteTransaction): WriteHoldWindow {
  return {
    beganMs: transaction.beganMs,
    endedMs: transaction.endedMs,
    longestMs: transaction.endedMs - transaction.beganMs,
    transactions: 1,
    caller: transaction.caller,
  }
}

function entryFor(window: WriteHoldWindow): StoreWriteHoldEntry | null {
  const spanMs = window.endedMs - window.beganMs
  if (spanMs < WRITE_HOLD_LOG_MS) return null
  return {
    at: new Date(window.endedMs).toISOString(),
    store: 'hub.db',
    spanMs,
    longestMs: window.longestMs,
    transactions: window.transactions,
    caller: window.caller ?? 'unknown',
  }
}

/** Extend or close the current burst window after one depth-zero transaction finishes. */
export function finishWriteTransaction(
  current: WriteHoldWindow | null,
  transaction: FinishedWriteTransaction,
): { state: WriteHoldWindow; entry: StoreWriteHoldEntry | null } {
  if (!current || transaction.beganMs - current.endedMs > WRITE_HOLD_BURST_GAP_MS) {
    return { state: openedWindow(transaction), entry: current ? entryFor(current) : null }
  }
  const durationMs = transaction.endedMs - transaction.beganMs
  const longest = durationMs > current.longestMs
  return {
    state: {
      beganMs: current.beganMs,
      endedMs: transaction.endedMs,
      longestMs: longest ? durationMs : current.longestMs,
      transactions: current.transactions + 1,
      caller: longest ? (transaction.caller ?? current.caller) : current.caller,
    },
    entry: null,
  }
}

export function writeTransactionNeedsCaller(
  current: WriteHoldWindow | null,
  beganMs: number,
  durationMs: number,
): boolean {
  const sameWindow =
    current && beganMs - current.endedMs <= WRITE_HOLD_BURST_GAP_MS ? current : null
  return durationMs >= WRITE_HOLD_CALLER_MS && durationMs > (sameWindow?.longestMs ?? -1)
}
