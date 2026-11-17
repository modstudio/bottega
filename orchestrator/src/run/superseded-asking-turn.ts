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
