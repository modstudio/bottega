import { describe, expect, test } from 'bun:test'
import { type ChainTreeCandidate, decideChainTreeAttach } from './chain-tree-attach.ts'

const candidate: ChainTreeCandidate = {
  path: '/trees/older',
  ownerRunId: 'older-run',
  exists: true,
  checkedOutBranch: 'DEV-2644-work',
  head: 'aaaa',
  clean: true,
  liveRunId: null,
  relation: 'equal',
  headOnly: [],
  tipOnly: [],
}

function decide(overrides: Partial<ChainTreeCandidate> = {}, candidates?: ChainTreeCandidate[]) {
  return decideChainTreeAttach({
    branch: 'DEV-2644-work',
    branchTip: 'aaaa',
    candidates: candidates ?? [{ ...candidate, ...overrides }],
    branchHolderOutsideChain: null,
  })
}

describe('chain tree attach decision', () => {
  test.each([
    ['earlier tree on branch', {}, 'attach', undefined, false],
    ['detached at tip', { checkedOutBranch: null }, 'attach', undefined, true],
    ['dirty detached tree falls through', { checkedOutBranch: null, clean: false }, 'none', undefined, undefined],
    [
      'head ahead',
      { checkedOutBranch: null, relation: 'head-ahead' },
      'refuse',
      'fast-forward-branch',
      undefined,
    ],
    [
      'tip ahead',
      { checkedOutBranch: null, relation: 'tip-ahead' },
      'refuse',
      'choose-work',
      undefined,
    ],
    [
      'diverged',
      { checkedOutBranch: null, relation: 'diverged' },
      'refuse',
      'choose-work',
      undefined,
    ],
    [
      'live run',
      { checkedOutBranch: null, liveRunId: 'live-run' },
      'refuse',
      'wait-or-stop',
      undefined,
    ],
  ] as const)('%s', (_name, overrides, action, remedyKind, switchToBranch) => {
    const result = decide(overrides)
    expect(result.action).toBe(action)
    expect(result.action === 'refuse' ? result.remedy.kind : undefined).toBe(remedyKind)
    expect(result.action === 'attach' ? result.switchToBranch : undefined).toBe(switchToBranch)
  })

  test('outside holder blocks switching a detached tree', () => {
    const result = decideChainTreeAttach({
      branch: 'DEV-2644-work',
      branchTip: 'aaaa',
      candidates: [{ ...candidate, checkedOutBranch: null }],
      branchHolderOutsideChain: '/trees/outside',
    })
    expect(result).toMatchObject({ action: 'refuse', remedy: { kind: 'held-outside-chain' } })
  })

  test('the latest recorded tree on the branch attaches without cleanliness or liveness checks', () => {
    const result = decide({ clean: false, liveRunId: 'live-run' })
    expect(result).toMatchObject({ action: 'attach', switchToBranch: false })
  })

  test('an earlier dirty tree on the branch attaches', () => {
    const result = decide({}, [
      { ...candidate, path: '/trees/gone', ownerRunId: 'latest-run', exists: false },
      { ...candidate, clean: false },
    ])
    expect(result).toMatchObject({ action: 'attach', path: candidate.path, switchToBranch: false })
  })

  test('no existing chain tree falls through', () => {
    expect(decide({ exists: false })).toEqual({ action: 'none' })
  })

  test('the newest existing tree is chosen', () => {
    const result = decide({}, [
      { ...candidate, path: '/trees/newest', ownerRunId: 'newest-run' },
      { ...candidate, path: '/trees/older', ownerRunId: 'older-run' },
    ])
    expect(result).toMatchObject({
      action: 'attach',
      path: '/trees/newest',
      ownerRunId: 'newest-run',
    })
  })
})
