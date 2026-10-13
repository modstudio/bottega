export const BOARD_PURPOSES = ['information', 'request', 'standing'] as const

export type BoardPurpose = (typeof BOARD_PURPOSES)[number]

export function parseBoardPurpose(value?: string): BoardPurpose {
  if (value === undefined || value === '') return 'information'
  if (BOARD_PURPOSES.includes(value as BoardPurpose)) return value as BoardPurpose
  throw new Error(`unsupported board purpose ${value}; use information, request, or standing`)
}
