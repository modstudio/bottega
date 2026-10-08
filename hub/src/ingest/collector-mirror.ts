import {
  type HostedStatusEvent,
  type HostedTask,
  isTaskMirrorAdoption,
  type MirrorAdoption,
} from '../hosted-tasks.ts'
import { rememberHostedInstall } from '../install-binding.ts'
import { projects } from '../projects.ts'
import { persistTaskAdoptions } from '../task-adoption.ts'
import {
  assertTargetSpaceTaskMirror,
  type HostedTaskIdentity,
  hostedMirrorTasks,
  hostedTaskIdentity,
} from '../task-client.ts'
import { partitionProjectRows } from '../task-project-space.ts'

type CollectedTaskRow = Pick<
  HostedTask,
  | 'title'
  | 'status'
  | 'status_category'
  | 'parent_key'
  | 'body'
  | 'assignee'
  | 'opened_at'
  | 'closed_at'
  | 'source'
  | 'first_seen'
  | 'last_seen'
  | 'updated_at'
> & {
  record_id: string
  key: string
  project: string
}

function hostedTaskBody(row: CollectedTaskRow): HostedTask {
  return {
    id: row.record_id,
    key: row.key,
    project: row.project,
    project_name: row.project,
    title: row.title,
    status: row.status,
    status_category: row.status_category,
    parent_key: row.parent_key,
    body: row.body,
    assignee: row.assignee,
    opened_at: row.opened_at,
    closed_at: row.closed_at,
    source: row.source,
    first_seen: row.first_seen,
    last_seen: row.last_seen,
    created_at: row.first_seen,
    updated_at: row.updated_at,
    deleted_at: null,
  }
}

type CollectorMirrorKind = 'tasks' | 'statusEvents'
type CollectorMirrorSkip = {
  project: string
  reason: string
  tasks: number
  statusEvents: number
}

export type CollectorMirrorPass = {
  mirrorTasks(rows: readonly CollectedTaskRow[]): Promise<CollectorMirrorResult>
  mirrorStatusEvents(rows: readonly HostedStatusEvent[]): Promise<CollectorMirrorResult>
  refusedReason?(): string | null
  reportSkipped(): void
}

type CollectorMirrorResult = 'mirrored' | 'refused' | 'not-applicable' | 'unreadable'

/** Load hosted identity once and apply the task project-space rule for one collection pass. */
export async function createCollectorMirrorPass(
  label: 'git' | 'tracker',
): Promise<CollectorMirrorPass> {
  let identity: HostedTaskIdentity | null = null
  let identityError: Error | null = null
  let identityErrorBlocksMirroring = false
  try {
    identity = await hostedTaskIdentity()
  } catch (cause) {
    identityError = cause instanceof Error ? cause : new Error(String(cause))
  }
  if (identity) {
    try {
      assertTargetSpaceTaskMirror(identity)
      rememberHostedInstall(identity.activeSpaceId)
    } catch (cause) {
      identity = null
      identityError = cause instanceof Error ? cause : new Error(String(cause))
      identityErrorBlocksMirroring = true
    }
  }
  const registered = projects()
  const skipped = new Map<string, CollectorMirrorSkip>()
  const skip = (project: string, reason: string, kind: CollectorMirrorKind) => {
    const key = `${project}\0${reason}`
    const entry = skipped.get(key) ?? { project, reason, tasks: 0, statusEvents: 0 }
    entry[kind]++
    skipped.set(key, entry)
  }
  const grouped = <T extends { project_name: string }>(
    rows: readonly T[],
    kind: CollectorMirrorKind,
  ) => {
    if (!identity) {
      for (const row of rows) skip(row.project_name, 'identity-unreadable', kind)
      return { destinations: new Map<string, T[]>(), refusals: new Map<string, Set<string>>() }
    }
    const partitioned = partitionProjectRows(rows, registered, identity)
    const refusals = new Map<string, Set<string>>()
    for (const [project, refusal] of partitioned.refusals) {
      for (const _row of refusal.rows) skip(project, refusal.reason, kind)
      refusals.set(project, new Set([refusal.reason]))
    }
    return { destinations: partitioned.destinations, refusals }
  }

  const failure = (failures: Map<string, Set<string>>) =>
    new Error(
      [...failures]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([project, reasons]) => `${project}: ${[...reasons].sort().join(', ')}`)
        .join('; '),
    )
  const mergedFailures = (...maps: Array<Map<string, Set<string>>>) => {
    const merged = new Map<string, Set<string>>()
    for (const map of maps)
      for (const [project, incoming] of map) {
        const reasons = merged.get(project) ?? new Set<string>()
        for (const reason of incoming) reasons.add(reason)
        merged.set(project, reasons)
      }
    return merged
  }
  const deliver = async <T extends { project_name: string }>(
    destinations: Map<string, T[]>,
    refusals: Map<string, Set<string>>,
    kind: CollectorMirrorKind,
    write: (spaceId: string, selected: T[]) => Promise<void>,
  ) => {
    let delivered = false
    const failures = new Map<string, Set<string>>()
    for (const [spaceId, selected] of destinations) {
      try {
        await write(spaceId, selected)
        delivered = true
      } catch (error) {
        const reason = `delivery-failed: ${(error as Error).message}`
        for (const project of new Set(selected.map((row) => row.project_name))) {
          skip(project, reason, kind)
          const reasons = failures.get(project) ?? new Set<string>()
          reasons.add(reason)
          failures.set(project, reasons)
        }
      }
    }
    if (failures.size || (destinations.size > 0 && refusals.size))
      throw failure(mergedFailures(refusals, failures))
    return delivered
  }
  const resultAfterDelivery = (
    delivered: boolean,
    refusals: Map<string, Set<string>>,
  ): CollectorMirrorResult =>
    delivered ? 'mirrored' : refusals.size ? 'refused' : identity ? 'not-applicable' : 'unreadable'

  return {
    async mirrorTasks(rows) {
      if (!identity && identityErrorBlocksMirroring) throw identityError
      const { destinations, refusals } = grouped(rows.map(hostedTaskBody), 'tasks')
      const delivered = await deliver(
        destinations,
        refusals,
        'tasks',
        async (spaceId, selected) => {
          const response = await hostedMirrorTasks({ tasks: selected }, { recordSpace: spaceId })
          const adoptions: MirrorAdoption[] = response.adoptions ?? []
          persistTaskAdoptions(adoptions.filter(isTaskMirrorAdoption))
        },
      )
      return resultAfterDelivery(delivered, refusals)
    },
    async mirrorStatusEvents(rows) {
      if (!identity && identityErrorBlocksMirroring) throw identityError
      const { destinations, refusals } = grouped(rows, 'statusEvents')
      const delivered = await deliver(
        destinations,
        refusals,
        'statusEvents',
        async (spaceId, selected) => {
          await hostedMirrorTasks({ tasks: [], statusEvents: selected }, { recordSpace: spaceId })
        },
      )
      return resultAfterDelivery(delivered, refusals)
    },
    refusedReason() {
      const refusals = new Map<string, Set<string>>()
      for (const entry of skipped.values()) {
        if (entry.reason === 'identity-unreadable' || entry.reason.startsWith('delivery-failed:'))
          continue
        const reasons = refusals.get(entry.project) ?? new Set<string>()
        reasons.add(entry.reason)
        refusals.set(entry.project, reasons)
      }
      return refusals.size ? failure(refusals).message : null
    },
    reportSkipped() {
      for (const entry of [...skipped.values()].sort(
        (a, b) => a.project.localeCompare(b.project) || a.reason.localeCompare(b.reason),
      ))
        console.error(
          `hub: ${label} mirror skipped project=${entry.project} reason=${entry.reason} tasks=${entry.tasks} statusEvents=${entry.statusEvents}${
            entry.reason === 'identity-unreadable' && identityError
              ? ` error=${identityError.message}`
              : ''
          }`,
        )
    },
  }
}
