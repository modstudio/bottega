// concern: continuation provisioning adapter
/** Gathers seed facts for the pure continuation provisioning decision and renders refusals. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { type Project, resolvedWorktreeTool } from '../project/projects.ts'
import { projectSeedPreflight } from '../worktree/worktree-seed.ts'
import { continuationProvisioningDecision } from './continuation-provision-decision.ts'
import type { ContinuationTreeDecision } from './continuation-tree-decision.ts'
import { continuationReusesIntactTree } from './continuation-tree-service.ts'

function continuationProvisionRefusal(rootId: string, seedRefusal: string): string {
  return (
    `run ${rootId} cannot be continued: it must recreate its worktree and has no recorded launch seed\n` +
    `${seedRefusal}\n` +
    `cleared by: ${PLATFORM_SLUG} run start --seed <value>`
  )
}

export function requireContinuationProvision(input: {
  rootId: string
  treeDecision: ContinuationTreeDecision
  recordedSeed: string | undefined
  writesRepo: boolean
  project: Project | null
}): { seed: string | undefined } {
  const seed = projectSeedPreflight({
    requested: undefined,
    inherited: input.recordedSeed,
    writesRepo: input.writesRepo,
    project: input.project,
    tool: resolvedWorktreeTool(input.project),
  })
  const decision = continuationProvisioningDecision({
    reuseIntactTree: continuationReusesIntactTree(input.treeDecision),
    seed,
  })
  if (decision.action === 'refuse') {
    throw new Error(continuationProvisionRefusal(input.rootId, seed.refusal!))
  }
  return { seed: decision.action === 'provision' ? decision.seed : input.recordedSeed }
}
