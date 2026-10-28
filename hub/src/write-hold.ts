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

function sameBurst(current: WriteHoldWindow | null, beganMs: number): current is WriteHoldWindow {
  return current !== null && beganMs - current.endedMs <= WRITE_HOLD_BURST_GAP_MS
}

function loggedWindow(window: WriteHoldWindow): WriteHoldWindow | null {
  return window.endedMs - window.beganMs >= WRITE_HOLD_LOG_MS ? window : null
}

/** Extend or close the current burst window after one depth-zero transaction finishes. */
export function finishWriteTransaction(
  current: WriteHoldWindow | null,
  transaction: FinishedWriteTransaction,
): { state: WriteHoldWindow; closed: WriteHoldWindow | null } {
  if (!sameBurst(current, transaction.beganMs)) {
    return { state: openedWindow(transaction), closed: current ? loggedWindow(current) : null }
  }
  const durationMs = transaction.endedMs - transaction.beganMs
  const longest = durationMs > current.longestMs
  return {
    state: {
      beganMs: current.beganMs,
      endedMs: transaction.endedMs,
      longestMs: longest ? durationMs : current.longestMs,
      transactions: current.transactions + 1,
      caller: longest
        ? (transaction.caller ?? current.caller)
        : (current.caller ?? transaction.caller),
    },
    closed: null,
  }
}

export function writeTransactionNeedsCaller(
  current: WriteHoldWindow | null,
  beganMs: number,
  durationMs: number,
): boolean {
  const sameWindow = sameBurst(current, beganMs) ? current : null
  if (sameWindow?.transactions === 1 && sameWindow.caller === null) return true
  return durationMs >= WRITE_HOLD_CALLER_MS && durationMs > (sameWindow?.longestMs ?? -1)
}
