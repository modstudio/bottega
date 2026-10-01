import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const DOCKER_INVENTORY_TIMEOUT_MS = 1_000
const DOCKER_INVENTORY_RETRY_TIMEOUT_MS = 10_000
const DOCKER_REMOVAL_TIMEOUT_MS = 10_000

export function dockerInventoryTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.ORCH_DOCKER_INVENTORY_TIMEOUT_MS
  if (raw === undefined || raw === '') return DOCKER_INVENTORY_TIMEOUT_MS
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : DOCKER_INVENTORY_TIMEOUT_MS
}

export function dockerRemovalTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.ORCH_DOCKER_REMOVAL_TIMEOUT_MS
  if (raw === undefined || raw === '') return DOCKER_REMOVAL_TIMEOUT_MS
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : DOCKER_REMOVAL_TIMEOUT_MS
}

type DockerResourceKind = 'container' | 'network' | 'volume'

export type DockerResource = {
  kind: DockerResourceKind
  name: string
  runId: number
  workingDir?: string | null
  composeProject?: string | null
  mainCheckout?: boolean
}

const ORCH_RUN_LABEL_KEY = 'orch.run'

export type DockerInventory =
  | {
      ascertainable: true
      resources: DockerResource[]
      unattributable?: {
        kind: DockerResourceKind
        name: string
        reason: string
        workingDir: string
      }[]
    }
  | { ascertainable: false; reason: string }

type DockerNetwork = {
  name: string
  createdAt: string | null
  workingDir: string | null
  runId: number | null
  composeProject: string | null
}

export type DockerNetworkInventory =
  | { ascertainable: true; networks: DockerNetwork[] }
  | { ascertainable: false; reason: string }

function list(
  kind: 'container' | 'volume',
  timeout: number,
):
  | { ascertainable: true; rows: { name: string; labels: Record<string, string> }[] }
  | { ascertainable: false; reason: string } {
  const args =
    kind === 'container'
      ? [
          'docker',
          'ps',
          '-a',
          '--format',
          `{{.Names}}\t{{.Label "${ORCH_RUN_LABEL_KEY}"}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.project.working_dir"}}`,
        ]
      : [
          'docker',
          'volume',
          'ls',
          '--format',
          `{{.Name}}\t{{.Label "${ORCH_RUN_LABEL_KEY}"}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.project.working_dir"}}`,
        ]
  let p: ReturnType<typeof Bun.spawnSync>
  try {
    p = Bun.spawnSync(args, {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout,
    })
  } catch (error) {
    return {
      ascertainable: false,
      reason: `docker ${args.slice(1, 3).join(' ')} inventory unavailable: ${(error as Error).message}`,
    }
  }
  if (p.exitedDueToTimeout) {
    return {
      ascertainable: false,
      reason:
        `docker ${args.slice(1, 3).join(' ')} inventory unavailable: ` +
        `timed out after ${timeout}ms`,
    }
  }
  if (p.exitCode !== 0) {
    const detail = p.stderr?.toString().trim() || `exit ${p.exitCode}`
    return {
      ascertainable: false,
      reason: `docker ${args.slice(1, 3).join(' ')} inventory unavailable: ${detail}`,
    }
  }
  return {
    ascertainable: true,
    rows: (p.stdout?.toString() ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [name, label = '', composeProject = '', workingDir = ''] = line.split('\t')
        const labels: Record<string, string> = {}
        if (label) labels[ORCH_RUN_LABEL_KEY] = label
        if (composeProject) labels['com.docker.compose.project'] = composeProject
        if (workingDir) labels['com.docker.compose.project.working_dir'] = workingDir
        return { name: name!, labels }
      }),
  }
}

/** The one identity rule shared by worktree names and their Docker resources. */
export function orchRunId(name: string): number | null {
  const match = name.match(/(?:^|[/_-])orch-(\d+)(?=[/_-]|$)/)
  if (!match) return null
  return Number(match[1])
}

export function orchRunLabel(rootRunId: number): string {
  return `${ORCH_RUN_LABEL_KEY}=${rootRunId}`
}

export function runIdFromLabels(labels: Record<string, string> | null | undefined): number | null {
  const value = labels?.[ORCH_RUN_LABEL_KEY]
  if (!value || !/^\d+$/.test(value)) return null
  const runId = Number(value)
  return Number.isSafeInteger(runId) ? runId : null
}

export function dockerRunResource(
  name: string,
  labels?: Record<string, string> | null,
): { runId: number } | null {
  const runId = runIdFromLabels(labels) ?? orchRunId(name)
  return runId === null ? null : { runId }
}

type UnattributableDockerResource = {
  kind: DockerResourceKind
  name: string
  reason: string
  workingDir: string
}

function classifyListedRows(
  kind: 'container' | 'volume',
  listed: { name: string; labels: Record<string, string> }[],
): { resources: DockerResource[]; unattributable: UnattributableDockerResource[] } {
  const resources: DockerResource[] = []
  const unattributable: UnattributableDockerResource[] = []
  for (const row of listed) {
    const workingDir = row.labels['com.docker.compose.project.working_dir'] ?? null
    const composeProject = row.labels['com.docker.compose.project'] ?? null
    const parsed =
      dockerRunResource(row.name, row.labels) ??
      (composeProject ? dockerRunResource(composeProject) : null) ??
      (workingDir ? dockerRunResource(workingDir) : null)
    if (parsed)
      resources.push({ kind, name: row.name, runId: parsed.runId, composeProject, workingDir })
    else if (workingDir?.includes('/.claude/worktrees/'))
      unattributable.push({
        kind,
        name: row.name,
        reason: `compose working directory ${workingDir} has no attributable run`,
        workingDir,
      })
  }
  return { resources, unattributable }
}

function classifyNetworkRows(networks: DockerNetwork[]): {
  resources: DockerResource[]
  unattributable: UnattributableDockerResource[]
} {
  const resources: DockerResource[] = []
  const unattributable: UnattributableDockerResource[] = []
  for (const network of networks) {
    const runId =
      network.runId ??
      (network.composeProject ? orchRunId(network.composeProject) : null) ??
      (network.workingDir ? orchRunId(network.workingDir) : null)
    if (runId !== null)
      resources.push({
        kind: 'network',
        name: network.name,
        runId,
        workingDir: network.workingDir,
        composeProject: network.composeProject,
      })
    else if (network.workingDir?.includes('/.claude/worktrees/'))
      unattributable.push({
        kind: 'network',
        name: network.name,
        reason: `compose working directory ${network.workingDir} has no attributable run`,
        workingDir: network.workingDir,
      })
  }
  return { resources, unattributable }
}

function protectMainCheckoutResources(rows: DockerResource[], paths: string[]): DockerResource[] {
  const mainPaths = new Set(paths.map((path) => resolve(path)))
  const mainComposeProjects = new Set(
    rows
      .filter((row) => row.workingDir && mainPaths.has(resolve(row.workingDir)))
      .flatMap((row) => (row.composeProject ? [row.composeProject] : [])),
  )
  return rows.map((row) => ({
    ...row,
    mainCheckout:
      Boolean(row.workingDir && mainPaths.has(resolve(row.workingDir))) ||
      Boolean(row.composeProject && mainComposeProjects.has(row.composeProject)),
  }))
}

/** Inventory only resources created for orch run worktrees. Never mutates Docker. */
export function dockerRunResources(mainCheckoutPaths: string[] = []): DockerInventory {
  const rows: DockerResource[] = []
  const unattributable: UnattributableDockerResource[] = []
  const configuredTimeout = dockerInventoryTimeoutMs()
  const explicitTimeout = process.env.ORCH_DOCKER_INVENTORY_TIMEOUT_MS
  for (const kind of ['container', 'volume'] as const) {
    let found = list(kind, configuredTimeout)
    // The idle-machine default gets one materially longer chance under load.
    // An explicit bound remains exact for the test gate and other callers.
    if (!found.ascertainable && !explicitTimeout && found.reason.includes('timed out')) {
      found = list(kind, DOCKER_INVENTORY_RETRY_TIMEOUT_MS)
    }
    if (!found.ascertainable) return found
    const classified = classifyListedRows(kind, found.rows)
    rows.push(...classified.resources)
    unattributable.push(...classified.unattributable)
  }
  const networks = dockerNetworkInventory()
  if (!networks.ascertainable) return networks
  const networkRows = classifyNetworkRows(networks.networks)
  rows.push(...networkRows.resources)
  unattributable.push(...networkRows.unattributable)
  const resources = protectMainCheckoutResources(rows, mainCheckoutPaths)
  return {
    ascertainable: true,
    resources,
    ...(unattributable.length ? { unattributable } : {}),
  }
}

/** Inventory Compose networks and the two ownership signals the monitor can prove. */
export function dockerNetworkInventory(): DockerNetworkInventory {
  const timeout = dockerInventoryTimeoutMs()
  let listed: ReturnType<typeof Bun.spawnSync>
  try {
    listed = Bun.spawnSync(['docker', 'network', 'ls', '--format', '{{.Name}}'], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout,
    })
  } catch (error) {
    return {
      ascertainable: false,
      reason: `docker network inventory unavailable: ${(error as Error).message}`,
    }
  }
  if (listed.exitedDueToTimeout) {
    return {
      ascertainable: false,
      reason: `docker network inventory unavailable: timed out after ${timeout}ms`,
    }
  }
  if (listed.exitCode !== 0) {
    return {
      ascertainable: false,
      reason: `docker network inventory unavailable: ${listed.stderr?.toString().trim() || `exit ${listed.exitCode}`}`,
    }
  }
  const names = (listed.stdout?.toString() ?? '')
    .split('\n')
    .map((name) => name.trim())
    .filter(Boolean)
  if (!names.length) return { ascertainable: true, networks: [] }

  let inspected: ReturnType<typeof Bun.spawnSync>
  try {
    inspected = Bun.spawnSync(['docker', 'network', 'inspect', ...names], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout,
    })
  } catch (error) {
    return {
      ascertainable: false,
      reason: `docker network inspection unavailable: ${(error as Error).message}`,
    }
  }
  if (inspected.exitedDueToTimeout) {
    return {
      ascertainable: false,
      reason: `docker network inspection unavailable: timed out after ${timeout}ms`,
    }
  }
  if (inspected.exitCode !== 0) {
    return {
      ascertainable: false,
      reason: `docker network inspection unavailable: ${inspected.stderr?.toString().trim() || `exit ${inspected.exitCode}`}`,
    }
  }
  try {
    const rows = JSON.parse(inspected.stdout?.toString() ?? '') as {
      Name: string
      Created?: string
      Labels?: Record<string, string> | null
    }[]
    return {
      ascertainable: true,
      networks: rows.map((row) => ({
        name: row.Name,
        createdAt: row.Created ?? null,
        workingDir: row.Labels?.['com.docker.compose.project.working_dir'] ?? null,
        runId: runIdFromLabels(row.Labels) ?? orchRunId(row.Name),
        composeProject: row.Labels?.['com.docker.compose.project'] ?? null,
      })),
    }
  } catch (error) {
    return {
      ascertainable: false,
      reason: `docker network inspection unavailable: ${(error as Error).message}`,
    }
  }
}

function resourcesForRun(runId: number, inventory = dockerRunResources()): DockerInventory {
  return resourcesForRuns([runId], inventory)
}

export function resourcesForRuns(
  runIds: number[],
  inventory = dockerRunResources(),
): DockerInventory {
  if (!inventory.ascertainable) return inventory
  const owned = new Set(runIds)
  return {
    ascertainable: true,
    resources: inventory.resources.filter((resource) => owned.has(resource.runId)),
  }
}

/** Remove Docker infrastructure created for one run, without touching its worktree. */
export type DockerTeardown = {
  complete: boolean
  errors: string[]
  removed: number
  skipped: boolean
}

function removeDockerResource(resource: DockerResource): string | null {
  const command = dockerRemovalCommand(resource)
  let process: ReturnType<typeof Bun.spawnSync>
  try {
    process = Bun.spawnSync(command.split(' '), {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: dockerRemovalTimeoutMs(),
    })
  } catch (error) {
    return `${command} failed: ${(error as Error).message}`
  }
  if (process.exitedDueToTimeout)
    return `${command} failed: timed out after ${dockerRemovalTimeoutMs()}ms`
  if (process.exitCode === 0) return null
  const detail = process.stderr?.toString().trim() || `exit ${process.exitCode}`
  return /no such (?:container|network|volume)/i.test(detail)
    ? null
    : `${command} failed: ${detail}`
}

export function teardownRunResources(
  runId: number,
  inventory = resourcesForRun(runId),
  canRemove: () => boolean = () => true,
): DockerTeardown {
  const errors = inventory.ascertainable ? [] : [inventory.reason]
  let removed = 0
  let skipped = !inventory.ascertainable
  for (const error of errors) console.error(`orch: ${error}`)
  if (!inventory.ascertainable) {
    return { complete: false, errors, removed, skipped }
  }

  const ordered = ['container', 'network', 'volume'] as const
  for (const resource of ordered.flatMap((kind) =>
    inventory.resources.filter((item) => item.kind === kind),
  )) {
    // Keep the identity check at the mutation boundary as well as in
    // resourcesForRun(): an inventory may be supplied or changed independently.
    if (resource.runId !== runId) continue
    if (resource.mainCheckout) {
      skipped = true
      errors.push(`refused to remove main-checkout Docker resource ${resource.name}`)
      continue
    }
    if (!canRemove()) {
      skipped = true
      break
    }
    const detail = removeDockerResource(resource)
    if (detail) {
      errors.push(detail)
      console.error(`orch: ${detail}`)
      continue
    }
    removed += 1
  }
  return { complete: errors.length === 0, errors, removed, skipped }
}

export type RunResourceOwner = {
  id: number
  repo: string | null
  worktree: string | null
  status: string
  retentionReason?: string | null
  absentTreeTeardown?: boolean
}

export type DockerResourceCondition = 'leaked' | 'retained-worktree-resources'

export function classifiedDockerResources(
  resources: DockerResource[],
  owners: RunResourceOwner[],
): {
  resource: DockerResource
  project: string
  condition: DockerResourceCondition
  reason: string | null
}[] {
  const byId = new Map(owners.map((owner) => [owner.id, owner]))
  return resources.flatMap((resource) => {
    const owner = byId.get(resource.runId)
    if (
      owner &&
      !owner.retentionReason &&
      !['ok', 'failed', 'stale', 'stopped'].includes(owner.status)
    )
      return []
    return [
      {
        resource,
        project: owner?.repo ?? 'unknown',
        condition:
          owner?.retentionReason ||
          owner?.absentTreeTeardown ||
          (owner?.worktree && existsSync(owner.worktree))
            ? ('retained-worktree-resources' as const)
            : ('leaked' as const),
        reason: owner?.retentionReason ?? null,
      },
    ]
  })
}

export function leakedResourceLines(resources: DockerResource[], project: string): string[] {
  return resources.map(
    (resource) =>
      `${resource.kind} ${resource.name} leaked by project ${project} (run ${resource.runId})`,
  )
}

export function dockerRemovalCommand(resource: DockerResource): string {
  if (resource.kind === 'container') return `docker rm -f ${resource.name}`
  if (resource.kind === 'network') return `docker network rm ${resource.name}`
  return `docker volume rm ${resource.name}`
}
