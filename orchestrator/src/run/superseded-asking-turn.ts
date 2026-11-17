// concern: superseded asking turn
/** Knows only when a continued chain has moved past an asking turn. */

export type ChainTurnState = {
  recordId: string
  rootId: string
  number: number
  turn: number
  status: string
}

export type SupersededAskingTurn = {
  recordId: string
  supersededByNumber: number
}

export type AskingTurnAuditRow = {
  recordId: string
  action: string
  at: string
  rowId: number
  reason: string | null
}

export type OverwrittenAbandonedAskingTurn = {
  recordId: string
  reason: string | null
}

/** An asking continuation turn is superseded exactly when its chain has a later turn. */
export function supersededAskingTurns(turns: ChainTurnState[]): SupersededAskingTurn[] {
  const byRoot = Map.groupBy(turns, (turn) => turn.rootId)
  return [...byRoot.values()].flatMap((chain) =>
    chain.flatMap((candidate) => {
      if (candidate.status !== 'asking') return []
      const successor = chain
        .filter((turn) => turn.turn > candidate.turn)
        .sort((left, right) => left.turn - right.turn || left.number - right.number)[0]
      return successor
        ? [{ recordId: candidate.recordId, supersededByNumber: successor.number }]
        : []
    }),
  )
}

/** An asking row lost an abandon verdict when the latest chain audit is abandon. */
export function overwrittenAbandonedAskingTurns(
  rows: AskingTurnAuditRow[],
): OverwrittenAbandonedAskingTurn[] {
  return [...Map.groupBy(rows, (row) => row.recordId).values()].flatMap((audits) => {
    const latest = audits.sort(
      (left, right) => right.at.localeCompare(left.at) || right.rowId - left.rowId,
    )[0]
    return latest?.action === 'abandon'
      ? [{ recordId: latest.recordId, reason: latest.reason }]
      : []
  })
}
