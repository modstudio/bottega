// concern: orphan-inventory-conditions
/** Owns monitor conditions over leftover Compose networks, sandbox homes, and vendor trust headings. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { SandboxDirectoryInventory } from '../resources/resource-inventory.ts'
import { age } from './monitor-conditions.ts'
import type { MonitorCondition } from './monitor-types.ts'

type DockerNetworkOwner = {
  rootId: string
  terminal: boolean
  hasWorktree: boolean
}

export type ObservedDockerNetworkInventory =
  | {
      ascertainable: true
      networks: {
        name: string
        createdAt: string | null
        workingDir: string | null
        runId: string | null
        workingDirExists: boolean
      }[]
      owners: DockerNetworkOwner[]
    }
  | { ascertainable: false; reason: string }

/** Decide which observed Compose networks have no remaining worktree owner. */
export function orphanDockerNetworkConditions(
  inventory: ObservedDockerNetworkInventory,
  clock: number,
): { conditions: MonitorCondition[]; errors: string[] } {
  if (!inventory.ascertainable) return { conditions: [], errors: [inventory.reason] }
  const owners = new Map(inventory.owners.map((owner) => [owner.rootId, owner]))
  const conditions = inventory.networks.flatMap((network): MonitorCondition[] => {
    const vanishedWorkdir = network.workingDir !== null && !network.workingDirExists
    const owner = network.runId === null ? null : owners.get(network.runId)
    const terminalOwnerWithoutTree = Boolean(owner?.terminal && !owner.hasWorktree)
    if (!vanishedWorkdir && !terminalOwnerWithoutTree) return []
    const since = network.createdAt ? new Date(network.createdAt).toISOString() : null
    const evidence = vanishedWorkdir
      ? `compose working directory is gone: ${network.workingDir}`
      : `terminal conversation ${network.runId} has no worktree`
    return [
      {
        kind: 'orphan-docker-network',
        subject: network.name,
        since,
        ageMs: age(since, clock),
        detail: `Docker network ${network.name}; ${evidence}`,
        action: 'reported; no established removal verb',
      },
    ]
  })
  return { conditions, errors: [] }
}

/** Report sandbox homes only after every turn in their conversation is terminal. */
export function orphanSandboxDirectoryConditions(inventory: SandboxDirectoryInventory): {
  conditions: MonitorCondition[]
  errors: string[]
} {
  if (!inventory.ascertainable) return { conditions: [], errors: [inventory.reason] }
  const conversations = new Map(
    inventory.conversations.map((conversation) => [conversation.rootId, conversation]),
  )
  const conditions = inventory.directories.flatMap((directory): MonitorCondition[] => {
    if (!conversations.get(directory.rootId)?.terminal) return []
    return [
      {
        kind: 'orphan-sandbox-dir',
        subject: directory.path,
        since: null,
        ageMs: null,
        detail: `sandbox directory for terminal conversation ${directory.rootId} uses ${directory.sizeBytes} bytes`,
        action: `run ${PLATFORM_SLUG} machine reclaim sandbox ${directory.rootId} --dry-run, then ${PLATFORM_SLUG} machine reclaim sandbox ${directory.rootId}`,
      },
    ]
  })
  return { conditions, errors: [] }
}

export type TrustEntryInventory =
  | {
      ascertainable: true
      entries: {
        runId: string
        heading: string
        path: string | null
        pathExists: boolean
        registeredProjectPath: boolean
        worktreeExists: boolean
      }[]
    }
  | { ascertainable: false; reason: string }

function trustHeadingStale(facts: {
  path: string | null
  pathExists: boolean
  registeredProjectPath: boolean
  worktreeExists: boolean
}): boolean {
  return (
    facts.path !== null &&
    !facts.pathExists &&
    !facts.registeredProjectPath &&
    !facts.worktreeExists
  )
}

/** Report recorded vendor trust headings after the run's worktree is gone. */
export function staleTrustEntryConditions(inventory: TrustEntryInventory): {
  conditions: MonitorCondition[]
  errors: string[]
} {
  if (!inventory.ascertainable) return { conditions: [], errors: [inventory.reason] }
  const conditions = inventory.entries.flatMap((entry): MonitorCondition[] => {
    if (!trustHeadingStale(entry)) return []
    return [
      {
        kind: 'stale-trust-entry',
        subject: `run:${entry.runId}:${entry.heading}`,
        since: null,
        ageMs: null,
        detail: `run ${entry.runId} recorded Grok trust heading ${entry.heading} after its worktree disappeared`,
        action: `run ${PLATFORM_SLUG} machine reclaim trust ${entry.runId} --dry-run, then ${PLATFORM_SLUG} machine reclaim trust ${entry.runId}`,
      },
    ]
  })
  const errors = inventory.entries.flatMap((entry) =>
    entry.path === null
      ? [`run ${entry.runId} recorded Grok trust heading without a quoted path: ${entry.heading}`]
      : [],
  )
  return { conditions, errors }
}
