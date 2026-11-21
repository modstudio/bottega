import { describe, expect, test } from 'bun:test'
import {
  treeProcessCwdCallerGroupHolderPids,
  treeProcessCwdDecision,
} from './tree-process-cwd-decision.ts'

const decide = (
  cwdByPid: ReadonlyMap<number, string>,
  options: {
    excludedPids?: ReadonlySet<number>
    scanError?: string | null
    treePaths?: string[]
  } = {},
) =>
  treeProcessCwdDecision({
    treePaths: options.treePaths ?? ['/real/tree'],
    cwdByPid,
    excludedPids: options.excludedPids ?? new Set([99]),
    scanError: options.scanError ?? null,
  })

describe('tree process cwd decision', () => {
  test('holds for a process at the tree root', () => {
    expect(decide(new Map([[12, '/real/tree']]))).toEqual({
      action: 'hold',
      reason: { kind: 'processes', processes: [{ pid: 12, cwd: '/real/tree' }] },
    })
  })

  test('holds for a process in a tree subdirectory', () => {
    expect(decide(new Map([[12, '/real/tree/packages/app']])).action).toBe('hold')
  })

  test('proceeds when every process is outside the tree', () => {
    expect(decide(new Map([[12, '/real/other']]))).toEqual({ action: 'proceed' })
  })

  test('proceeds when every pid inside the tree is excluded', () => {
    expect(decide(new Map([[12, '/real/tree']]), { excludedPids: new Set([12]) })).toEqual({
      action: 'proceed',
    })
  })

  test('holds only a non-ancestor sibling inside the tree', () => {
    expect(
      decide(
        new Map([
          [12, '/real/tree'],
          [13, '/real/tree/packages/app'],
        ]),
        { excludedPids: new Set([12, 99]) },
      ),
    ).toEqual({
      action: 'hold',
      reason: {
        kind: 'processes',
        processes: [{ pid: 13, cwd: '/real/tree/packages/app' }],
      },
    })
  })

  test('holds with the scan failure cause', () => {
    expect(decide(new Map(), { scanError: 'lsof timed out' })).toEqual({
      action: 'hold',
      reason: { kind: 'scan-error', cause: 'lsof timed out' },
    })
  })

  test('holds when a cwd matches only the recorded tree spelling', () => {
    expect(
      decide(new Map([[12, '/recorded/tree/subdir']]), {
        treePaths: ['/physical/tree', '/recorded/tree'],
      }),
    ).toMatchObject({ action: 'hold' })
  })
})

describe('tree process cwd caller-group classification', () => {
  const classify = (facts: { pid: number; pgid: number }[], holderPids = [21]) =>
    treeProcessCwdCallerGroupHolderPids({ facts, processPid: 20, holderPids })

  test('classifies every same-group holder as caller-owned without excluding the hold', () => {
    const facts = [
      { pid: 20, pgid: 10 },
      { pid: 21, pgid: 10 },
      { pid: 22, pgid: 10 },
    ]
    expect(classify(facts, [21, 22])).toEqual([21, 22])
    expect(decide(new Map([[21, '/real/tree']]))).toMatchObject({ action: 'hold' })
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
    const facts = pgid === null ? [{ pid: 21, pgid: 10 }] : [{ pid: 20, pgid }, { pid: 21, pgid }]
    expect(classify(facts)).toBeNull()
  })
})
