// concern: close-out tree process cwd decision
/** Decides whether process working directories prove a tree is still in use. */

import { workingDirectoryIsInsideTree } from '../worktree/removal-working-directory.ts'

export type TreeProcessCwdDecision =
  | { action: 'proceed' }
  | { action: 'hold'; reason: { kind: 'scan-error'; cause: string } }
  | {
      action: 'hold'
      reason: { kind: 'processes'; processes: { pid: number; cwd: string }[] }
    }

/** All paths are real paths; the adapter resolves them before asking the decision. */
export function treeProcessCwdDecision(input: {
  treePath: string
  cwdByPid: ReadonlyMap<number, string>
  ownPid: number
  scanError: string | null
}): TreeProcessCwdDecision {
  if (input.scanError) {
    return { action: 'hold', reason: { kind: 'scan-error', cause: input.scanError } }
  }
  const processes = [...input.cwdByPid]
    .filter(
      ([pid, cwd]) => pid !== input.ownPid && workingDirectoryIsInsideTree(cwd, input.treePath),
    )
    .map(([pid, cwd]) => ({ pid, cwd }))
    .sort((left, right) => left.pid - right.pid)
  return processes.length > 0
    ? { action: 'hold', reason: { kind: 'processes', processes } }
    : { action: 'proceed' }
}
