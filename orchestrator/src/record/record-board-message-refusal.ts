import { BOARD_BODY_MAX_CHARS } from '../board/board-policy.ts'
import { boardTextSecretRefusal } from '../board/board-text-secret.ts'

function hostedBoardTextRefusal(label: string, noun: string, value: string): string | null {
  if (!value.trim()) return `${noun} is required${noun.endsWith(' body') ? '; provide body' : ''}`
  if (value.length > BOARD_BODY_MAX_CHARS)
    return `${noun.endsWith(' error') ? label : noun} exceeds ${BOARD_BODY_MAX_CHARS} characters; shorten it`
  return boardTextSecretRefusal(label, value)
}

export function hostedBoardReplyBodyRefusal(body: string): string | null {
  return hostedBoardTextRefusal('board reply', 'board reply body', body)
}

export function hostedBoardFilingFailRefusal(error: string): string | null {
  return hostedBoardTextRefusal('board filing failure', 'filing failure error', error)
}
