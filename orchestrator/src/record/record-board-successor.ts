// concern: record-board-successor
/** Elects one hosted successor for a report reply. Must not know HTTP or local stores. */

import {
  type HostedBoardSuccessorInput,
  type HostedBoardSuccessorResult,
  RecordBoardError,
} from './record-board-contract.ts'
import { type BoardTenant, withBoardTenant } from './record-board-tx.ts'

export async function takeHostedBoardSuccessor(
  input: BoardTenant & HostedBoardSuccessorInput,
): Promise<HostedBoardSuccessorResult> {
  if (!input.candidateSession.trim())
    throw new RecordBoardError('board successor requires candidateSession', 400)
  return withBoardTenant(input, true, async (tx) => {
    const available = (await tx`
      SELECT to_regprocedure('public.board_reply_elect_successor(uuid,text)') IS NOT NULL AS available
    `) as { available: boolean }[]
    if (!available[0]?.available)
      throw new RecordBoardError(
        'board successor election requires the current record migration',
        409,
      )
    const rows = (await tx`
      SELECT elected, holder
      FROM public.board_reply_elect_successor(${input.messageId}::uuid, ${input.candidateSession})
    `) as HostedBoardSuccessorResult[]
    const result = rows[0]
    if (!result) throw new RecordBoardError(`board reply ${input.messageId} not found`, 404)
    return result
  })
}
