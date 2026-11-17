import { describe, expect, test } from 'bun:test'
import {
  type AskingTurnAuditRow,
  type ChainTurnState,
  overwrittenAbandonedAskingTurns,
  supersededAskingTurns,
} from './superseded-asking-turn.ts'

const turn = (turn: number, status: string): ChainTurnState => ({
  recordId: `run-${turn}`,
  rootId: 'root',
  number: 100 + turn,
  turn,
  status,
})

describe('superseded asking turns', () => {
  test('calls asking turn 2 superseded when the chain has ok turn 3', () => {
    expect(supersededAskingTurns([turn(2, 'asking'), turn(3, 'ok')])).toEqual([
      { recordId: 'run-2', supersededByNumber: 103 },
    ])
  })

  test('does not supersede the latest asking turn', () => {
    expect(supersededAskingTurns([turn(2, 'ok'), turn(3, 'asking')])).toEqual([])
  })

  test('does not use a later turn from another root', () => {
    expect(
      supersededAskingTurns([
        { ...turn(2, 'asking'), rootId: 'root-a' },
        { ...turn(3, 'ok'), rootId: 'root-b' },
      ]),
    ).toEqual([])
  })
})

describe('overwritten architect abandon verdicts', () => {
  const audit = (
    action: string,
    at: string,
    rowId: number,
    reason: string | null = null,
  ): AskingTurnAuditRow => ({ recordId: 'run-2', action, at, rowId, reason })

  test('uses the latest audit time and row id to decide whether abandon is latest', () => {
    expect(
      overwrittenAbandonedAskingTurns([
        audit('abandon', '2026-11-17T01:00:00.000Z', 1, 'operator note'),
        audit('continue', '2026-11-17T01:00:00.000Z', 2),
      ]),
    ).toEqual([])
    expect(
      overwrittenAbandonedAskingTurns([
        audit('continue', '2026-11-17T01:00:00.000Z', 1),
        audit('abandon', '2026-11-17T01:00:00.000Z', 2, 'operator note'),
      ]),
    ).toEqual([{ recordId: 'run-2', reason: 'operator note' }])
  })
})
