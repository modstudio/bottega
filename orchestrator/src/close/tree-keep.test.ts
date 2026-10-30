import { describe, expect, test } from 'bun:test'
import { decideTreeKeep, type TreeNamer } from './tree-keep.ts'

const cursor: TreeNamer = {
  kind: 'cursor',
  number: 1003,
  workflow: 'ship-task',
  project: 'segnavia',
}
const liveRun: TreeNamer = { kind: 'live-run', recordId: 'run-record-id' }

describe('tree keep decision', () => {
  for (const intent of ['terminal', 'sweep'] as const) {
    test(`${intent} proceeds without a namer and holds for either namer kind`, () => {
      expect(decideTreeKeep({ intent, namers: [] })).toEqual({ action: 'proceed' })
      expect(decideTreeKeep({ intent, namers: [cursor] })).toEqual({
        action: 'hold',
        namers: [cursor],
      })
      expect(decideTreeKeep({ intent, namers: [liveRun] })).toEqual({
        action: 'hold',
        namers: [liveRun],
      })
    })
  }

  for (const intent of ['explicit', 'tree-remove'] as const) {
    test(`${intent} proceeds without a namer and reports either namer kind`, () => {
      expect(decideTreeKeep({ intent, namers: [] })).toEqual({ action: 'proceed' })
      expect(decideTreeKeep({ intent, namers: [cursor] })).toEqual({
        action: 'proceed-named',
        namers: [cursor],
      })
      expect(decideTreeKeep({ intent, namers: [liveRun] })).toEqual({
        action: 'proceed-named',
        namers: [liveRun],
      })
    })
  }
})
