// concern: session close-out resource release
/** Pure qualification and reporting for removed-tree process and Compose reclamation. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { TERMINAL_RUN_STATUS_SET } from '../run/run-status.ts'
import type { SessionProcessLine } from './session-close-out-report.ts'

export type SessionReleasedTree = {
  rootRecordId: string
  outcome: 'released' | 'absent'
}

export type SessionResourceReleaseTarget = {
  rootRecordId: string
  path: string
  runRecordIds: string[]
}

export type SessionResourceReclaimerResult = {
  reclaimed: string[]
  kept: { item: string; reason: string }[]
  errors: string[]
}

export type SessionResourceReleaseReport = {
  mechanical: string[]
  process: SessionProcessLine[]
}

/** Select terminal chains whose tree release was proved by this close-out invocation. */
export function sessionResourceReleaseTargets(
  runs: readonly {
    recordId: string
    rootRecordId: string
    status: string
    worktree: string | null
  }[],
  releasedTrees: readonly SessionReleasedTree[],
): SessionResourceReleaseTarget[] {
  const releasedRoots = new Set(releasedTrees.map((tree) => tree.rootRecordId))
  const targets: SessionResourceReleaseTarget[] = []
  for (const [rootRecordId, members] of Map.groupBy(runs, (run) => run.rootRecordId)) {
    if (!releasedRoots.has(rootRecordId)) continue
    if (!members.every((run) => TERMINAL_RUN_STATUS_SET.has(run.status))) continue
    const paths = [...new Set(members.flatMap((run) => (run.worktree ? [run.worktree] : [])))]
    for (const path of paths)
      targets.push({
        rootRecordId,
        path,
        runRecordIds: members.map((run) => run.recordId),
      })
  }
  return targets
}

function processItem(
  target: SessionResourceReleaseTarget,
  item: string,
  reason: string,
): SessionProcessLine {
  return {
    item,
    reason,
    evidence: `removed tree ${target.path} for run chain ${target.rootRecordId}`,
    remedy: `${PLATFORM_SLUG} session close-out`,
  }
}

/** Map both reclaimers onto close-out's mechanical and process report shapes. */
export function sessionResourceReleaseReport(
  target: SessionResourceReleaseTarget,
  processes: SessionResourceReclaimerResult,
  compose: SessionResourceReclaimerResult,
): SessionResourceReleaseReport {
  return {
    mechanical: [
      ...processes.reclaimed.map((line) => `reclaimed process: ${line}`),
      ...compose.reclaimed.map((line) => `reclaimed Compose resource: ${line}`),
    ],
    process: [
      ...processes.kept.map((kept) => processItem(target, kept.item, kept.reason)),
      ...processes.errors.map((reason) => processItem(target, 'removed-tree processes', reason)),
      ...compose.kept.map((kept) => processItem(target, kept.item, kept.reason)),
      ...compose.errors.map((reason) =>
        processItem(target, 'removed-tree Compose resources', reason),
      ),
    ],
  }
}

export function sessionResourceReleaseDryRunLines(
  targets: readonly SessionResourceReleaseTarget[],
): string[] {
  return targets.flatMap((target) => [
    `would reclaim processes for removed tree ${target.path}`,
    `would reclaim Compose resources for removed tree ${target.path}`,
  ])
}
