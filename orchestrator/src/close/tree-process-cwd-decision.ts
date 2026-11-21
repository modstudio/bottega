// concern: close-out tree process cwd decision
/** Decides whether process working directories prove a tree is still in use. */

import { workingDirectoryIsInsideTree } from '../worktree/removal-working-directory.ts'
import { isProcessGroupPgid } from '../idle-kill.ts'
import { processGroupForPid, type ProcessFact } from '../resources/process-inventory.ts'

/** Identify a process-cwd hold proved to contain only the caller's process group. */
export function treeProcessCwdCallerGroupHolderPids(input: {
  facts: readonly Pick<ProcessFact, 'pid' | 'pgid'>[]
  processPid: number
  holderPids: readonly number[]
}): readonly number[] | null {
  const processGroup = processGroupForPid(input.facts, input.processPid)
  if (!isProcessGroupPgid(processGroup) || input.holderPids.length === 0) return null
  return input.holderPids.every(
    (holderPid) => processGroupForPid(input.facts, holderPid) === processGroup,
  )
    ? [...input.holderPids]
    : null
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
