// concern: chain tree attach
/** Selects a chain-owned tree for continuation without reading Git or run state. */

export type ChainTreeRelation = 'equal' | 'head-ahead' | 'tip-ahead' | 'diverged'

export type ChainTreeCandidate = {
  path: string
  ownerRunId: string
  exists: boolean
  checkedOutBranch: string | null
  head: string
  clean: boolean
  liveRunId: string | null
  relation: ChainTreeRelation
  headOnly: readonly string[]
  tipOnly: readonly string[]
}

export type ChainTreeAttachRemedy =
  | { kind: 'wait-or-stop'; runId: string }
  | { kind: 'dirty' }
  | { kind: 'fast-forward-branch'; head: string; tip: string }
  | {
      kind: 'choose-work'
      head: string
      tip: string
      headOnly: readonly string[]
      tipOnly: readonly string[]
    }
  | { kind: 'held-outside-chain'; holder: string }

export type ChainTreeAttachDecision =
  | { action: 'none' }
  | { action: 'attach'; path: string; ownerRunId: string; switchToBranch: boolean }
  | { action: 'refuse'; path: string; remedy: ChainTreeAttachRemedy }

export function decideChainTreeAttach(input: {
  branch: string
  branchTip: string | null
  candidates: readonly ChainTreeCandidate[]
  branchHolderOutsideChain: string | null
}): ChainTreeAttachDecision {
  const latest = input.candidates[0]
  if (latest?.exists && latest.checkedOutBranch === input.branch) {
    return {
      action: 'attach',
      path: latest.path,
      ownerRunId: latest.ownerRunId,
      switchToBranch: false,
    }
  }
  const candidate = input.candidates.find((item) => item.exists)
  if (!candidate) return { action: 'none' }
  if (candidate.liveRunId) {
    return {
      action: 'refuse',
      path: candidate.path,
      remedy: { kind: 'wait-or-stop', runId: candidate.liveRunId },
    }
  }
  if (candidate.checkedOutBranch === input.branch) {
    return {
      action: 'attach',
      path: candidate.path,
      ownerRunId: candidate.ownerRunId,
      switchToBranch: false,
    }
  }
  if (!candidate.clean) return { action: 'none' }
  if (!input.branchTip) return { action: 'none' }
  if (candidate.relation === 'equal') {
    if (input.branchHolderOutsideChain) {
      return {
        action: 'refuse',
        path: candidate.path,
        remedy: { kind: 'held-outside-chain', holder: input.branchHolderOutsideChain },
      }
    }
    return {
      action: 'attach',
      path: candidate.path,
      ownerRunId: candidate.ownerRunId,
      switchToBranch: true,
    }
  }
  if (candidate.relation === 'head-ahead') {
    return {
      action: 'refuse',
      path: candidate.path,
      remedy: { kind: 'fast-forward-branch', head: candidate.head, tip: input.branchTip },
    }
  }
  return {
    action: 'refuse',
    path: candidate.path,
    remedy: {
      kind: 'choose-work',
      head: candidate.head,
      tip: input.branchTip,
      headOnly: candidate.headOnly,
      tipOnly: candidate.tipOnly,
    },
  }
}
