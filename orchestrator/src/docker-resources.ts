import { existsSync } from 'node:fs'

export const DOCKER_INVENTORY_TIMEOUT_MS = 1_000
export const DOCKER_INVENTORY_RETRY_TIMEOUT_MS = 10_000
export const DOCKER_REMOVAL_TIMEOUT_MS = 10_000

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

export type DockerResourceKind = 'container' | 'volume'

export type DockerResource = {
  kind: DockerResourceKind
  name: string
  runId: number
}

export type DockerInventory =
  | { ascertainable: true; resources: DockerResource[] }
  | { ascertainable: false; reason: string }

export type DockerNetwork = {
  name: string
  createdAt: string | null
  workingDir: string | null
  runId: number | null
}

export type DockerNetworkInventory =
  | { ascertainable: true; networks: DockerNetwork[] }
  | { ascertainable: false; reason: string }

function list(
  kind: DockerResourceKind,
  timeout: number,
): { ascertainable: true; names: string[] } | { ascertainable: false; reason: string } {
  const args =
    kind === 'container'
      ? ['docker', 'ps', '-a', '--format', '{{.Names}}']
      : ['docker', 'volume', 'ls', '--format', '{{.Name}}']
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
    names: (p.stdout?.toString() ?? '')
      .split('\n')
      .map((name) => name.trim())
      .filter(Boolean),
  }
}

/** The one identity rule shared by worktree names and their Docker resources. */
export function orchRunId(name: string): number | null {
  const match = name.match(/(?:^|[_-])orch-(\d+)(?=[_-]|$)/)
  if (!match) return null
  return Number(match[1])
}

export function dockerRunResource(name: string): { runId: number } | null {
  const runId = orchRunId(name)
  return runId === null ? null : { runId }
}

/** Inventory only resources created for orch run worktrees. Never mutates Docker. */
export function dockerRunResources(): DockerInventory {
  const resources: DockerResource[] = []
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
    for (const name of found.names) {
      const parsed = dockerRunResource(name)
      if (parsed) resources.push({ kind, name, runId: parsed.runId })
    }
  }
  return { ascertainable: true, resources }
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
        runId: orchRunId(row.Name),
      })),
    }
  } catch (error) {
    return {
      ascertainable: false,
      reason: `docker network inspection unavailable: ${(error as Error).message}`,
    }
  }
}

export function resourcesForRun(runId: number, inventory = dockerRunResources()): DockerInventory {
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

  // Volumes are durable evidence. The project's worktree removal owns their lifecycle.
  for (const resource of inventory.resources.filter((item) => item.kind === 'container')) {
    // Keep the identity check at the mutation boundary as well as in
    // resourcesForRun(): an inventory may be supplied or changed independently.
    if (resource.runId !== runId) continue
    if (!canRemove()) {
      skipped = true
      break
    }
    const command = dockerRemovalCommand(resource)
    let p: ReturnType<typeof Bun.spawnSync>
    try {
      p = Bun.spawnSync(command.split(' '), {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: dockerRemovalTimeoutMs(),
      })
    } catch (error) {
      const detail = `${command} failed: ${(error as Error).message}`
      errors.push(detail)
      console.error(`orch: ${detail}`)
      continue
    }
    if (p.exitedDueToTimeout) {
      const detail = `${command} failed: timed out after ${dockerRemovalTimeoutMs()}ms`
      errors.push(detail)
      console.error(`orch: ${detail}`)
      continue
    }
    if (p.exitCode !== 0) {
      const detail = p.stderr?.toString().trim() || `exit ${p.exitCode}`
      // A concurrent cleanup or a repeated teardown is successful idempotence.
      if (/no such (?:container|volume)/i.test(detail)) continue
      errors.push(`${command} failed: ${detail}`)
      console.error(`orch: ${command} failed: ${detail}`)
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
}

export type DockerResourceCondition = 'leaked' | 'retained-worktree-resources'

/** Live runs own their infrastructure even before a worktree path exists. */
export function orphanedDockerResources(
  resources: DockerResource[],
  owners: RunResourceOwner[],
): { resource: DockerResource; project: string }[] {
  const byId = new Map(owners.map((owner) => [owner.id, owner]))
  return resources.flatMap((resource) => {
    const owner = byId.get(resource.runId)
    if (owner && !['ok', 'failed', 'stale', 'stopped'].includes(owner.status)) return []
    return [{ resource, project: owner?.repo ?? 'unknown' }]
  })
}

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
          owner?.retentionReason || (owner?.worktree && existsSync(owner.worktree))
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
  return resource.kind === 'container'
    ? `docker rm -f ${resource.name}`
    : `docker volume rm ${resource.name}`
}
