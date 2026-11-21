// concern: close-out tree process cwd decision
/** Decides whether process working directories prove a tree is still in use. */

import { workingDirectoryIsInsideTree } from '../worktree/removal-working-directory.ts'

type ProcessGroupFact = { pid: number; pgid: number }

/** Exclude this command, its ancestors, and peers from the caller's process group. */
export function treeProcessCwdExcludedPids(input: {
  facts: readonly ProcessGroupFact[]
  processPid: number
  ancestorPids: readonly number[]
}): ReadonlySet<number> {
  const excluded = new Set([input.processPid, ...input.ancestorPids])
  const processGroup = input.facts.find(({ pid }) => pid === input.processPid)?.pgid
  if (processGroup === undefined || processGroup === 1) return excluded
  for (const fact of input.facts) {
    if (fact.pgid === processGroup) excluded.add(fact.pid)
  }
  return excluded
}

export type TreeProcessCwdDecision =
  | { action: 'proceed' }
  | { action: 'hold'; reason: { kind: 'scan-error'; cause: string } }
  | {
      action: 'hold'
      reason: { kind: 'processes'; processes: { pid: number; cwd: string }[] }
    }

/** Paths are normalized spellings; the adapter resolves them before asking the decision. */
export function treeProcessCwdDecision(input: {
  treePaths: readonly string[]
  cwdByPid: ReadonlyMap<number, string>
  excludedPids: ReadonlySet<number>
  scanError: string | null
}): TreeProcessCwdDecision {
  if (input.scanError) {
    return { action: 'hold', reason: { kind: 'scan-error', cause: input.scanError } }
  }
  const processes = [...input.cwdByPid]
    .filter(
      ([pid, cwd]) =>
        !input.excludedPids.has(pid) &&
        input.treePaths.some((treePath) => workingDirectoryIsInsideTree(cwd, treePath)),
    )
    .map(([pid, cwd]) => ({ pid, cwd }))
    .sort((left, right) => left.pid - right.pid)
  return processes.length > 0
    ? { action: 'hold', reason: { kind: 'processes', processes } }
    : { action: 'proceed' }
}
