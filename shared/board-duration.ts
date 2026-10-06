export const BOARD_DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000
export const BOARD_DEFAULT_ACK_DEADLINE_MS = 60 * 60 * 1000

export function parseBoardDuration(value: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(value.trim())
  if (!match) throw new Error(`invalid duration ${value}; use a positive value such as 30m or 1d`)
  const amount = Number(match[1])
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error(`invalid duration ${value}`)
  const factor = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
    match[2] as 'ms' | 's' | 'm' | 'h' | 'd'
  ]
  return amount * factor
}
