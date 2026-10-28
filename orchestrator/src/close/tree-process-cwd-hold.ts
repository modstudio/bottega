// concern: close-out tree process cwd observation
/** Observes process working directories and explains a close-out hold. */

import { existsSync, realpathSync } from 'node:fs'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { processWorkingDirectories } from '../resources/process-inventory.ts'
import { landingTreeReleaseHold } from './close-out-release-holds.ts'
import { treeProcessCwdDecision } from './tree-process-cwd-decision.ts'

function realWorkingDirectories(values: ReadonlyMap<number, string>): {
  values: Map<number, string>
  error: string | null
} {
  const resolved = new Map<number, string>()
  for (const [pid, cwd] of values) {
    try {
      resolved.set(pid, realpathSync(cwd))
    } catch (error) {
      return {
        values: resolved,
        error: `could not resolve cwd ${cwd} for pid ${pid}: ${String((error as Error).message ?? error)}`,
      }
    }
  }
  return { values: resolved, error: null }
}

function treeCwdHold(
  runId: string,
  treePath: string,
  treeAbsent: boolean,
  processes: readonly { pid: number; command: string }[],
): { runId: string; worktree: string; outcome: 'live'; detail: string } | null {
  if (treeAbsent || !existsSync(treePath)) return null
  const recordedTreePath = treePath
  let scanError: string | null = null
  try {
    treePath = realpathSync(treePath)
  } catch (error) {
    scanError = `could not resolve tree ${recordedTreePath}: ${String((error as Error).message ?? error)}`
  }
  const observed = processWorkingDirectories()
  const cwds = realWorkingDirectories(observed.values)
  const decision = treeProcessCwdDecision({
    treePath,
    cwdByPid: cwds.values,
    ownPid: process.pid,
    scanError: observed.error ?? scanError ?? cwds.error,
  })
  if (decision.action === 'proceed') return null
  const retry = `then run ${PLATFORM_SLUG} run close-out ${runId} or let ${PLATFORM_SLUG} machine sweep retry`
  let detail: string
  if (decision.reason.kind === 'scan-error') {
    detail = `process cwd scan could not establish whether ${recordedTreePath} is in use: ${decision.reason.cause}; tree and branch retained; cleared by: correct the scan failure, ${retry}`
  } else {
    const commands = new Map(processes.map(({ pid, command }) => [pid, command]))
    const holders = decision.reason.processes
      .map(
        ({ pid, cwd }) =>
          `pid ${pid}: ${commands.get(pid)?.trim() || '<command unavailable>'}; cwd ${cwd}`,
      )
      .join('\n')
    detail = `tree and branch retained because live processes have working directories inside ${recordedTreePath}:\n${holders}\ncleared by: stop the listed processes, or wait for them to finish, ${retry}`
  }
  return { runId, worktree: recordedTreePath, outcome: 'live', detail }
}

export function preArchiveHold(
  input: Parameters<typeof landingTreeReleaseHold>[0],
  treeAbsent: boolean,
  processes: readonly { pid: number; command: string }[],
) {
  return (
    landingTreeReleaseHold(input) ?? treeCwdHold(input.runId, input.worktree, treeAbsent, processes)
  )
}
