import { describe, expect, test } from 'bun:test'
import { treeProcessCwdCallerGroupHolderPids } from './tree-process-cwd-caller-group.ts'
import { treeProcessCwdDecision } from './tree-process-cwd-decision.ts'

const classify = (facts: { pid: number; pgid: number }[], holderPids = [21]) =>
  treeProcessCwdCallerGroupHolderPids({ facts, processPid: 20, holderPids })
const decide = (cwdByPid: ReadonlyMap<number, string>) =>
  treeProcessCwdDecision({
    treePaths: ['/real/tree'],
    cwdByPid,
    excludedPids: new Set([20, 10, 1]),
    scanError: null,
  })

describe('tree process cwd caller-group classification', () => {
  test('classifies every same-group holder without excluding the hold', () => {
    const facts = [
      { pid: 20, pgid: 10 },
      { pid: 21, pgid: 10 },
      { pid: 22, pgid: 10 },
    ]
    expect(classify(facts, [21, 22])).toEqual([21, 22])
    expect(decide(new Map([[21, '/real/tree']]))).toMatchObject({ action: 'hold' })
    expect(decide(new Map())).toEqual({ action: 'proceed' })
  })

  test('does not classify a foreign or mixed hold as caller-owned', () => {
    const facts = [
      { pid: 20, pgid: 10 },
      { pid: 21, pgid: 10 },
      { pid: 22, pgid: 22 },
    ]
    expect(classify(facts, [22])).toBeNull()
    expect(classify(facts, [21, 22])).toBeNull()
  })

  test.each([null, 0, 1])('does not classify unavailable or unsafe pgid %p', (pgid) => {
    const facts =
      pgid === null
        ? [{ pid: 21, pgid: 10 }]
        : [
            { pid: 20, pgid },
            { pid: 21, pgid },
          ]
    expect(classify(facts)).toBeNull()
  })
})
