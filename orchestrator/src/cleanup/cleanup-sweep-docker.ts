// concern: cleanup sweep Docker reclamation and reporting

import { existsSync } from 'node:fs'
import { db } from '../database/db.ts'
import {
  absentTreeTeardownPlan,
  isProjectRepository,
  type Project,
  projectByName,
  projects,
  resolvedWorktreeTool,
} from '../project/projects.ts'
import {
  classifiedDockerResources,
  type DockerInventory,
  type DockerResource,
  dockerRunResources,
  leakedResourceLines,
} from '../resources/docker-resources.ts'
import {
  teardownTerminalRunResources,
  terminalDockerRetentionReasonForRun,
} from '../resources/resource-ownership.ts'
import type { Worktree } from '../worktree/worktree-types.ts'
import type { CleanupPresentation } from './cleanup.ts'

type DockerOwner = {
  id: number
  repo: string | null
  worktree: string | null
  status: string
  worktree_source: Worktree['source'] | null
  recipe_snapshot: string | null
  resource_teardown: 'pending' | 'done' | null
  absentTreeTeardown: boolean
  retentionReason: string | null
}

function dockerOwners(ownerIds: Set<number>): DockerOwner[] {
  const rows = db()
    .query(
      `SELECT r.id,COALESCE(root.repo,r.repo) repo,r.worktree,r.status,
              COALESCE(root.worktree_source,r.worktree_source) worktree_source,
              COALESCE(root.recipe_snapshot,r.recipe_snapshot) recipe_snapshot,
              COALESCE(root.resource_teardown,r.resource_teardown) resource_teardown
       FROM run r LEFT JOIN run root ON root.id=r.parent_run_id`,
    )
    .all() as Omit<DockerOwner, 'absentTreeTeardown' | 'retentionReason'>[]
  return rows.map((owner) => ({
    ...owner,
    absentTreeTeardown:
      Boolean(owner.worktree && !existsSync(owner.worktree)) &&
      absentTreeTeardownPlan({
        recipeSnapshot: owner.recipe_snapshot,
        worktreeSource: owner.worktree_source,
        resourceTeardown: owner.resource_teardown,
        registeredRemoveCommand: Boolean(
          resolvedWorktreeTool(owner.repo ? projectByName(owner.repo) : null)?.remove,
        ),
      }),
    retentionReason: ownerIds.has(owner.id)
      ? terminalDockerRetentionReasonForRun(db(), owner.id)
      : null,
  }))
}

function reclaimTerminalOwners(input: {
  dryRun: boolean
  ownerIds: Set<number>
  owners: DockerOwner[]
  presentation: CleanupPresentation
  inventoryErrors: Set<string>
  inventory: DockerInventory
  selectedProject: Project | null
}): { failed: boolean; reclaimed: Set<number> } {
  const { dryRun, ownerIds, owners, presentation, inventoryErrors, inventory, selectedProject } =
    input
  const reclaimed = new Set<number>()
  let failed = false
  for (const owner of owners) {
    if (!terminalOwnerInScope(owner, ownerIds, selectedProject)) continue
    const teardown = teardownTerminalRunResources(db(), owner.id, inventory, { dryRun })
    if (teardown.complete && !teardown.skipped) reclaimed.add(owner.id)
    else failed = true
    for (const error of teardown.errors) inventoryErrors.add(error)
    if (dryRun && teardown.complete && !teardown.skipped && teardown.removed > 0)
      presentation.log(`would tear down disposable Docker resources for run ${owner.id}`)
  }
  return { failed, reclaimed }
}

function terminalOwnerInScope(
  owner: DockerOwner,
  ownerIds: Set<number>,
  selectedProject: Project | null,
): boolean {
  return (
    ownerIds.has(owner.id) &&
    ['ok', 'failed', 'stale', 'stopped'].includes(owner.status) &&
    (!selectedProject || owner.repo === selectedProject.name)
  )
}

function reportRetainedDockerResources(
  dryRun: boolean,
  retained: ReturnType<typeof classifiedDockerResources>,
  presentation: CleanupPresentation,
): void {
  if (retained.length) {
    presentation.error(
      `\n${dryRun ? 'would report ' : ''}retained worktree Docker resources: ${retained.length}`,
    )
    for (const { resource, project, reason } of retained)
      presentation.error(
        `  ${resource.kind} ${resource.name} re-served or retained by project ${project} (run ${resource.runId}); ${reason ? `removal could not be ascertained: ${reason}; ` : ''}no removal suggested`,
      )
  }
}

function reportLeakedDockerResources(
  dryRun: boolean,
  leaked: Map<string, { resource: DockerResource; project: string; runId: number }>,
  presentation: CleanupPresentation,
): void {
  if (leaked.size) {
    presentation.error(`\n${dryRun ? 'would report ' : ''}leaked Docker resources: ${leaked.size}`)
    for (const { resource, project } of leaked.values())
      presentation.error(
        `  ${dryRun ? 'would report ' : ''}${leakedResourceLines([resource], project)[0]}`,
      )
  }
}

function reportDockerInventoryErrors(
  dryRun: boolean,
  inventoryErrors: Set<string>,
  presentation: CleanupPresentation,
): void {
  if (inventoryErrors.size) {
    presentation.error(
      `\n${dryRun ? 'would report ' : ''}inventory unavailable: ${inventoryErrors.size}`,
    )
    for (const error of inventoryErrors)
      presentation.error(`  ${dryRun ? 'would report ' : ''}${error}`)
  }
}

export function reclaimSweptDockerResources(input: {
  dryRun: boolean
  selectedProject: Project | null
  presentation: CleanupPresentation
  inventoryErrors: Set<string>
  leaked: Map<string, { resource: DockerResource; project: string; runId: number }>
}): boolean {
  const { dryRun, selectedProject, presentation, inventoryErrors, leaked } = input
  const inventory = dockerRunResources(
    projects()
      .filter(isProjectRepository)
      .map(({ path }) => path),
  )
  if (!inventory.ascertainable) inventoryErrors.add(inventory.reason)
  let failed = !inventory.ascertainable
  const resources = inventory.ascertainable ? inventory.resources : []
  for (const resource of inventory.ascertainable ? (inventory.unattributable ?? []) : []) {
    if (
      selectedProject &&
      resource.workingDir !== selectedProject.path &&
      !resource.workingDir.startsWith(`${selectedProject.path}/`)
    )
      continue
    presentation.error(
      `${dryRun ? 'would report ' : ''}unattributable worktree Docker ${resource.kind} ${resource.name}: ${resource.reason}`,
    )
  }
  const ownerIds = new Set(resources.map(({ runId }) => runId))
  const owners = dockerOwners(ownerIds)
  const reclaimedResult = reclaimTerminalOwners({
    dryRun,
    ownerIds,
    owners,
    presentation,
    inventoryErrors,
    inventory,
    selectedProject,
  })
  failed ||= reclaimedResult.failed
  const classified = classifiedDockerResources(resources, owners).filter(
    (item) =>
      !reclaimedResult.reclaimed.has(item.resource.runId) &&
      (!selectedProject || item.project === selectedProject.name),
  )
  for (const { resource, project, condition } of classified) {
    if (condition === 'retained-worktree-resources') continue
    const key = `${resource.kind}:${resource.name}`
    if (!leaked.has(key)) leaked.set(key, { resource, project, runId: resource.runId })
  }
  const retained = classified.filter(({ condition }) => condition === 'retained-worktree-resources')
  failed ||= leaked.size > 0
  reportRetainedDockerResources(dryRun, retained, presentation)
  reportLeakedDockerResources(dryRun, leaked, presentation)
  reportDockerInventoryErrors(dryRun, inventoryErrors, presentation)
  return failed
}
