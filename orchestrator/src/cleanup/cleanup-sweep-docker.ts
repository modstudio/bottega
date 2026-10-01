// concern: cleanup sweep Docker reclamation and reporting

import { existsSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { db } from '../database/db.ts'
import { worktreeListPorcelain } from '../git/git-environment.ts'
import { withCleanupLock } from '../project/project-lock.ts'
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
  type UnattributableDockerResource,
  type UnattributedComposeDockerResource,
} from '../resources/docker-resources.ts'
import {
  isOrphanWorktreeDockerResource,
  teardownOrphanWorktreeDockerResources,
} from '../resources/orphan-worktree-docker.ts'
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

function directoryPresence(path: string): boolean | null {
  try {
    statSync(path)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : null
  }
}

function projectForWorktreeDirectory(workingDir: string, registered: Project[]): Project | null {
  const candidate = resolve(workingDir)
  return (
    registered.find((project) => {
      const root = resolve(project.path, '.claude/worktrees')
      const within = relative(root, candidate)
      return (
        Boolean(within) && within !== '..' && !within.startsWith(`..${sep}`) && !isAbsolute(within)
      )
    }) ?? null
  )
}

function listedWorktreePaths(project: Project): string[] | null {
  try {
    return worktreeListPorcelain(project.path)
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length))
  } catch {
    return null
  }
}

type OrphanDockerGroup = {
  project: Project
  resources: (UnattributableDockerResource | UnattributedComposeDockerResource)[]
  workingDirs: string[]
}

function recordedRunPointsTo(workingDirs: readonly string[]): boolean {
  const candidates = new Set(workingDirs.map((path) => resolve(path)))
  const rows = db().query('SELECT worktree FROM run WHERE worktree IS NOT NULL').all() as {
    worktree: string
  }[]
  return rows.some(({ worktree }) => candidates.has(resolve(worktree)))
}

function orphanComposeWorkingDirs(input: {
  containers: NonNullable<Extract<DockerInventory, { ascertainable: true }>['composeContainers']>
  project: Project
  registered: Project[]
  gitWorktreePaths: string[] | null
  mainCheckoutPaths: string[]
}): string[] | null {
  const { containers, project, registered, gitWorktreePaths, mainCheckoutPaths } = input
  const allOrphan = containers.every((container) => {
    if (!container.workingDir || container.runAttributed || container.mainCheckout) return false
    const owner = projectForWorktreeDirectory(container.workingDir, registered)
    return (
      owner?.id === project.id &&
      isOrphanWorktreeDockerResource({
        workingDir: container.workingDir,
        projectPath: project.path,
        directoryExists: directoryPresence(container.workingDir),
        gitWorktreePaths,
        mainCheckoutPaths,
        registeredMainCheckout: container.mainCheckout,
      })
    )
  })
  if (!allOrphan) return null
  return containers.flatMap(({ workingDir }) => (workingDir ? [workingDir] : []))
}

function composeContainersByProject(
  inventory: Extract<DockerInventory, { ascertainable: true }>,
): Map<string, NonNullable<typeof inventory.composeContainers>> {
  const grouped = new Map<string, NonNullable<typeof inventory.composeContainers>>()
  for (const container of inventory.composeContainers ?? []) {
    const containers = grouped.get(container.composeProject) ?? []
    containers.push(container)
    grouped.set(container.composeProject, containers)
  }
  return grouped
}

function orphanWorktreeDockerGroups(input: {
  selectedProject: Project | null
  inventory: Extract<DockerInventory, { ascertainable: true }>
}): { groups: OrphanDockerGroup[]; mainCheckoutPaths: string[] } {
  const { selectedProject, inventory } = input
  const registered = projects().filter(isProjectRepository)
  const mainCheckoutPaths = registered.map(({ path }) => path)
  const gitPaths = new Map<Project, string[] | null>()
  const grouped = new Map<string, OrphanDockerGroup>()
  const containersByComposeProject = composeContainersByProject(inventory)
  for (const [composeProject, containers] of containersByComposeProject) {
    if (containers.length === 0) continue
    const firstWorkingDir = containers[0]!.workingDir
    if (!firstWorkingDir) continue
    const project = projectForWorktreeDirectory(firstWorkingDir, registered)
    if (!project || (selectedProject && project.id !== selectedProject.id)) continue
    if (!gitPaths.has(project)) gitPaths.set(project, listedWorktreePaths(project))
    const workingDirs = orphanComposeWorkingDirs({
      containers,
      project,
      registered,
      gitWorktreePaths: gitPaths.get(project)!,
      mainCheckoutPaths,
    })
    if (!workingDirs || recordedRunPointsTo(workingDirs)) continue
    const resources = (inventory.unattributable ?? []).filter(
      (resource) => resource.kind === 'container' && resource.composeProject === composeProject,
    )
    if (resources.length !== containers.length) continue
    grouped.set(`${project.id}\0${composeProject}`, { project, resources, workingDirs })
  }
  const groups = [...grouped.values()]
  for (const group of groups) {
    const composeProject = group.resources[0]!.composeProject
    group.resources.push(
      ...(inventory.unattributable ?? []).filter(
        (resource) =>
          resource.kind !== 'container' &&
          resource.composeProject === composeProject &&
          !resource.mainCheckout &&
          !group.resources.includes(resource),
      ),
      ...(inventory.unattributedComposeResources ?? []).filter(
        (resource) => resource.composeProject === composeProject && !resource.mainCheckout,
      ),
    )
  }
  return { groups, mainCheckoutPaths }
}

function removeOrphanDockerGroup(input: {
  group: OrphanDockerGroup
  mainCheckoutPaths: string[]
  presentation: CleanupPresentation
  inventoryErrors: Set<string>
  handled: Set<UnattributableDockerResource>
  handledCompose: Set<UnattributedComposeDockerResource>
}): boolean {
  const { group, mainCheckoutPaths, presentation, inventoryErrors, handled, handledCompose } = input
  const { project, resources } = group
  const composeProject = resources[0]!.composeProject
  let result: ReturnType<typeof teardownOrphanWorktreeDockerResources>
  try {
    result = withCleanupLock(
      project.path,
      { session: null, what: `orphan Docker stack ${composeProject}` },
      () =>
        teardownOrphanWorktreeDockerResources(
          resources,
          mainCheckoutPaths,
          () =>
            !recordedRunPointsTo(group.workingDirs) &&
            group.workingDirs.every((workingDir) => directoryPresence(workingDir) === false),
        ),
    )
  } catch (error) {
    inventoryErrors.add(
      `orphan Docker stack cleanup failed for project ${project.name}, Compose project ${composeProject}: ${(error as Error).message}`,
    )
    return true
  }
  for (const resource of result.removed) {
    if (resource.workingDir === null) handledCompose.add(resource)
    else handled.add(resource)
    presentation.log(`removed orphan worktree Docker ${resource.kind} ${resource.name}`)
  }
  for (const error of result.errors) inventoryErrors.add(error)
  return !result.complete && !result.skipped
}

function reclaimOrphanWorktreeDockerResources(input: {
  dryRun: boolean
  selectedProject: Project | null
  presentation: CleanupPresentation
  inventoryErrors: Set<string>
  inventory: DockerInventory
}): {
  failed: boolean
  handled: Set<UnattributableDockerResource>
  handledCompose: Set<UnattributedComposeDockerResource>
} {
  const { dryRun, selectedProject, presentation, inventoryErrors, inventory } = input
  const handled = new Set<UnattributableDockerResource>()
  const handledCompose = new Set<UnattributedComposeDockerResource>()
  if (!inventory.ascertainable) return { failed: false, handled, handledCompose }
  const { groups, mainCheckoutPaths } = orphanWorktreeDockerGroups({
    selectedProject,
    inventory,
  })
  let failed = false
  for (const group of groups) {
    if (dryRun) {
      for (const resource of group.resources) {
        if (resource.workingDir === null) handledCompose.add(resource)
        else handled.add(resource)
        presentation.log(
          `would remove orphan worktree Docker ${resource.kind} ${resource.name} for Compose project ${resource.composeProject}`,
        )
      }
      continue
    }
    const groupFailed = removeOrphanDockerGroup({
      group,
      mainCheckoutPaths,
      presentation,
      inventoryErrors,
      handled,
      handledCompose,
    })
    failed ||= groupFailed
  }
  return { failed, handled, handledCompose }
}

function reportOwnerlessComposeRemnants(input: {
  dryRun: boolean
  presentation: CleanupPresentation
  inventory: Extract<DockerInventory, { ascertainable: true }>
  handled: Set<UnattributedComposeDockerResource>
}): void {
  const { dryRun, presentation, inventory, handled } = input
  const containerProjects = new Set(inventory.composeContainerProjects ?? [])
  const grouped = new Map<string, string[]>()
  for (const resource of inventory.unattributedComposeResources ?? []) {
    if (
      handled.has(resource) ||
      resource.mainCheckout ||
      containerProjects.has(resource.composeProject)
    )
      continue
    const names = grouped.get(resource.composeProject) ?? []
    names.push(resource.name)
    grouped.set(resource.composeProject, names)
  }
  for (const [project, names] of grouped) {
    presentation.error(
      `${dryRun ? 'would report ' : ''}ownerless Compose remnant ${project}: ${names.join(', ')}`,
    )
  }
}

function reportUnattributableDockerResources(input: {
  dryRun: boolean
  selectedProject: Project | null
  presentation: CleanupPresentation
  inventory: DockerInventory
  handled: Set<UnattributableDockerResource>
}): void {
  const { dryRun, selectedProject, presentation, inventory, handled } = input
  if (!inventory.ascertainable) return
  for (const resource of inventory.unattributable ?? []) {
    if (handled.has(resource)) continue
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
  const orphanResult = reclaimOrphanWorktreeDockerResources({
    dryRun,
    selectedProject,
    presentation,
    inventoryErrors,
    inventory,
  })
  failed ||= orphanResult.failed
  reportUnattributableDockerResources({
    dryRun,
    selectedProject,
    presentation,
    inventory,
    handled: orphanResult.handled,
  })
  if (inventory.ascertainable)
    reportOwnerlessComposeRemnants({
      dryRun,
      presentation,
      inventory,
      handled: orphanResult.handledCompose,
    })
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
