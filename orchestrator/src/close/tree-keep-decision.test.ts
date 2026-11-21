import { describe, expect, test } from 'bun:test'
import { CLOSE_OUT_INTENTS, decideTreeKeep, type TreeNamer } from './tree-keep-decision.ts'

const cursor: TreeNamer = {
  kind: 'cursor',
  number: 1003,
  workflow: 'ship-task',
  project: 'segnavia',
}
const liveRun: TreeNamer = { kind: 'live-run', recordId: 'run-record-id' }

describe('tree keep decision', () => {
  for (const intent of CLOSE_OUT_INTENTS) {
    test(`${intent} proceeds without a namer and classifies either namer kind`, () => {
      expect(decideTreeKeep({ intent, namers: [] })).toEqual({ action: 'proceed' })
      const action =
        intent === 'operator-removal' || intent === 'failed-provision' ? 'proceed-named' : 'hold'
      expect(decideTreeKeep({ intent, namers: [cursor] })).toEqual({ action, namers: [cursor] })
      expect(decideTreeKeep({ intent, namers: [liveRun] })).toEqual({
        action,
        namers: [liveRun],
      })
    })
  }

  test.each([false, null, undefined])('landed=%s holds a named tree', (landed) => {
    expect(decideTreeKeep({ intent: 'landed', namers: [cursor], landed })).toEqual({
      action: 'hold',
      namers: [cursor],
    })
  })

  test('landed=true proceeds on a named tree', () => {
    expect(decideTreeKeep({ intent: 'landed', namers: [cursor], landed: true })).toEqual({
      action: 'proceed-named',
      namers: [cursor],
    })
  })
})
