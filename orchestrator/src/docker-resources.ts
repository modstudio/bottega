import { existsSync } from 'node:fs'

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
    p = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe' })
  } catch (error) {
    return {
      names: [],
      error: `docker ${args.slice(1, 3).join(' ')} unavailable: ${(error as Error).message}`,
    }
  }
  if (p.exitCode !== 0) {
    const detail = p.stderr?.toString().trim() || `exit ${p.exitCode}`
    return { names: [], error: `docker ${args.slice(1, 3).join(' ')} unavailable: ${detail}` }
  }
  return {
    names: (p.stdout?.toString() ?? '').split('\n').map((name) => name.trim()).filter(Boolean),
    error: null,
  }
}

/** Docker Compose carries its project/worktree name at the start of every resource name. */
export function dockerRunResource(name: string): { runId: number; worktreeName: string } | null {
  const match = name.match(/^(orch-(\d+))(?:[_-]|$)/)
  if (!match) return null
  return { runId: Number(match[2]), worktreeName: match[1]! }
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

export function resourcesForWorktree(
  worktreeName: string, inventory = dockerRunResources(),
): DockerInventory {
  return {
    resources: inventory.resources.filter((resource) => {
      const parsed = dockerRunResource(resource.name)
      return parsed?.worktreeName === worktreeName
    }),
    errors: inventory.errors,
  }
}

export type RunResourceOwner = {
  id: number
  repo: string | null
  worktree: string | null
}

/** A resource is orphaned once no extant worktree remains to own its run infrastructure. */
export function orphanedDockerResources(
  resources: DockerResource[], owners: RunResourceOwner[],
): { resource: DockerResource; project: string }[] {
  const byId = new Map(owners.map((owner) => [owner.id, owner]))
  return resources.flatMap((resource) => {
    const owner = byId.get(resource.runId)
    if (owner?.worktree && existsSync(owner.worktree)) return []
    return [{ resource, project: owner?.repo ?? 'unknown' }]
  })
}

export function leakedResourceLines(
  resources: DockerResource[], project: string, runId: number,
): string[] {
  return resources.map((resource) =>
    `${resource.kind} ${resource.name} leaked by project ${project} (run ${runId})`)
}

export function dockerRemovalCommand(resource: DockerResource): string {
  return resource.kind === 'container'
    ? `docker rm -f ${resource.name}`
    : `docker volume rm ${resource.name}`
}
