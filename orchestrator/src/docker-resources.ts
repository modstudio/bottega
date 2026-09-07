import { existsSync } from 'node:fs'

export const DOCKER_INVENTORY_TIMEOUT_MS = 1_000

export function dockerInventoryTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.ORCH_DOCKER_INVENTORY_TIMEOUT_MS
  if (raw === undefined || raw === '') return DOCKER_INVENTORY_TIMEOUT_MS
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : DOCKER_INVENTORY_TIMEOUT_MS
}

export type DockerResourceKind = 'container' | 'volume'

export type DockerResource = {
  kind: DockerResourceKind
  name: string
  runId: number
}

export type DockerInventory = {
  resources: DockerResource[]
  errors: string[]
}

function list(kind: DockerResourceKind): { names: string[]; error: string | null } {
  const args = kind === 'container'
    ? ['docker', 'ps', '-a', '--format', '{{.Names}}']
    : ['docker', 'volume', 'ls', '--format', '{{.Name}}']
  let p: ReturnType<typeof Bun.spawnSync>
  try {
    const timeout = dockerInventoryTimeoutMs()
    p = Bun.spawnSync(args, {
      stdout: 'pipe', stderr: 'pipe', timeout,
    })
  } catch (error) {
    return {
      names: [],
      error: `docker ${args.slice(1, 3).join(' ')} inventory unavailable: ${(error as Error).message}`,
    }
  }
  if (p.exitedDueToTimeout) {
    return {
      names: [],
      error: `docker ${args.slice(1, 3).join(' ')} inventory unavailable: ` +
        `timed out after ${dockerInventoryTimeoutMs()}ms`,
    }
  }
  if (p.exitCode !== 0) {
    const detail = p.stderr?.toString().trim() || `exit ${p.exitCode}`
    return {
      names: [], error: `docker ${args.slice(1, 3).join(' ')} inventory unavailable: ${detail}`,
    }
  }
  return {
    names: (p.stdout?.toString() ?? '').split('\n').map((name) => name.trim()).filter(Boolean),
    error: null,
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
  const errors: string[] = []
  for (const kind of ['container', 'volume'] as const) {
    const found = list(kind)
    if (found.error) errors.push(found.error)
    for (const name of found.names) {
      const parsed = dockerRunResource(name)
      if (parsed) resources.push({ kind, name, runId: parsed.runId })
    }
  }
  return { resources, errors }
}

export function resourcesForRun(
  runId: number, inventory = dockerRunResources(),
): DockerInventory {
  return resourcesForRuns([runId], inventory)
}

export function resourcesForRuns(
  runIds: number[], inventory = dockerRunResources(),
): DockerInventory {
  const owned = new Set(runIds)
  return {
    resources: inventory.resources.filter((resource) => owned.has(resource.runId)),
    errors: inventory.errors,
  }
}

export type RunResourceOwner = {
  id: number
  repo: string | null
  worktree: string | null
  status: string
}

/** Live runs own their infrastructure even before a worktree path exists. */
export function orphanedDockerResources(
  resources: DockerResource[], owners: RunResourceOwner[],
): { resource: DockerResource; project: string }[] {
  const byId = new Map(owners.map((owner) => [owner.id, owner]))
  return resources.flatMap((resource) => {
    const owner = byId.get(resource.runId)
    if (owner && (!['ok', 'failed', 'stale', 'stopped'].includes(owner.status) ||
        (owner.worktree !== null && existsSync(owner.worktree)))) return []
    return [{ resource, project: owner?.repo ?? 'unknown' }]
  })
}

export function leakedResourceLines(
  resources: DockerResource[], project: string,
): string[] {
  return resources.map((resource) =>
    `${resource.kind} ${resource.name} leaked by project ${project} (run ${resource.runId})`)
}

export function dockerRemovalCommand(resource: DockerResource): string {
  return resource.kind === 'container'
    ? `docker rm -f ${resource.name}`
    : `docker volume rm ${resource.name}`
}
