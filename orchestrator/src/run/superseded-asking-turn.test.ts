import { describe, expect, test } from 'bun:test'
import { type ChainTurnState, supersededAskingTurns } from './superseded-asking-turn.ts'

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
