// concern: tree removal process cwd observation
/** Observes process working directories and explains a tree-removal hold. */

import { existsSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { processTableSnapshot, processWorkingDirectories } from '../resources/process-inventory.ts'
import { treeProcessCwdDecision } from './tree-process-cwd-decision.ts'

function realWorkingDirectories(values: ReadonlyMap<number, string>): {
  values: Map<number, string>
} {
  const resolved = new Map<number, string>()
  for (const [pid, cwd] of values) {
    try {
      resolved.set(pid, realpathSync(cwd))
    } catch {
      resolved.set(pid, resolve(cwd))
    }
  }
  return { values: resolved }
}

export function treeProcessCwdHold(input: {
  runId: string
  worktree: string
  treeAbsent: boolean
}): { runId: string; worktree: string; outcome: 'held'; detail: string } | null {
  const { runId, worktree: treePath, treeAbsent } = input
  if (treeAbsent || !existsSync(treePath)) return null
  const recordedTreePath = treePath
  const recordedTreeSpelling = resolve(recordedTreePath)
  let realTreePath = recordedTreeSpelling
  let scanError: string | null = null
  try {
    realTreePath = realpathSync(treePath)
  } catch (error) {
    scanError = `could not resolve tree ${recordedTreePath}: ${String((error as Error).message ?? error)}`
  }
  const observed = processWorkingDirectories()
  const cwds = realWorkingDirectories(observed.values)
  const decision = treeProcessCwdDecision({
    treePaths: [...new Set([realTreePath, recordedTreeSpelling])],
    cwdByPid: cwds.values,
    ownPid: process.pid,
    scanError: observed.error ?? scanError,
  })
  if (decision.action === 'proceed') return null
  const retry = `then run ${PLATFORM_SLUG} run close-out ${runId} or let ${PLATFORM_SLUG} machine sweep retry`
  let detail: string
  if (decision.reason.kind === 'scan-error') {
    detail = `process cwd scan could not establish whether ${recordedTreePath} is in use: ${decision.reason.cause}; tree and branch retained; cleared by: correct the scan failure, ${retry}`
  } else {
    const commands = new Map(processTableSnapshot().facts.map(({ pid, command }) => [pid, command]))
    const holders = decision.reason.processes
      .map(
        ({ pid, cwd }) =>
          `pid ${pid}: ${commands.get(pid)?.trim() || '<command unavailable>'}; cwd ${cwd}`,
      )
      .join('\n')
    detail = `tree and branch retained because live processes have working directories inside ${recordedTreePath}:\n${holders}\ncleared by: stop the listed processes, or wait for them to finish, ${retry}`
  }
  return { runId, worktree: recordedTreePath, outcome: 'held', detail }
}
