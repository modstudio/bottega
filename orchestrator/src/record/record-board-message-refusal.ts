import { BOARD_BODY_MAX_CHARS } from '../board/board-policy.ts'
import { boardTextSecretRefusal } from '../board/board-text-secret.ts'

export function hostedBoardReplyBodyRefusal(body: string): string | null {
  if (!body.trim()) return 'board reply body is required; provide body'
  if (body.length > BOARD_BODY_MAX_CHARS)
    return `board reply body exceeds ${BOARD_BODY_MAX_CHARS} characters; shorten it`
  return boardTextSecretRefusal('board reply', body)
}

export function hostedBoardFilingFailRefusal(error: string): string | null {
  if (!error.trim()) return 'filing failure error is required'
  if (error.length > BOARD_BODY_MAX_CHARS)
    return `board filing failure exceeds ${BOARD_BODY_MAX_CHARS} characters; shorten it`
  return boardTextSecretRefusal('board filing failure', error)
}
