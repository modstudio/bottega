export const BOARD_INFORMATION_DEFAULT_EXPIRY_MS = 4 * 60 * 60 * 1000
export const BOARD_REQUEST_DEFAULT_EXPIRY_MS = 4 * 60 * 60 * 1000
export const BOARD_STANDING_DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000
export const BOARD_DEFAULT_ACK_DEADLINE_MS = 60 * 60 * 1000

import type { BoardPurpose } from './board-purpose.ts'

export function boardDefaultExpiryMs(purpose: BoardPurpose): number {
  if (purpose === 'information') return BOARD_INFORMATION_DEFAULT_EXPIRY_MS
  if (purpose === 'request') return BOARD_REQUEST_DEFAULT_EXPIRY_MS
  return BOARD_STANDING_DEFAULT_EXPIRY_MS
}

export function extendedBoardThreadExpiry(
  currentExpiry: string | null,
  replyTime: number,
  purpose: BoardPurpose | null,
): string | null {
  if (currentExpiry === null) return null
  const extension = replyTime + boardDefaultExpiryMs(purpose ?? 'request')
  return new Date(Math.max(Date.parse(currentExpiry), extension)).toISOString()
}

export function parseBoardDuration(value: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(value.trim())
  const grammarMessage = `invalid duration ${value}; use a positive value such as 30m or 1d`
  if (!match) throw new Error(grammarMessage)
  const amount = Number(match[1])
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error(`invalid duration ${value}`)
  const factor = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
    match[2] as 'ms' | 's' | 'm' | 'h' | 'd'
  ]
  const milliseconds = amount * factor
  if (!Number.isSafeInteger(milliseconds)) throw new Error(grammarMessage)
  return milliseconds
}
