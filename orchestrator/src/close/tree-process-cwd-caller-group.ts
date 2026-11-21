// concern: tree removal caller process-group classification
/** Classifies a process-cwd hold from already-observed process facts. */

import { isProcessGroupPgid, processGroupForPid } from '../idle-kill.ts'
import type { ProcessFact } from '../resources/process-inventory.ts'

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
