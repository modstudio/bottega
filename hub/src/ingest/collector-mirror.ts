import {
  type HostedStatusEvent,
  type HostedTask,
  isTaskMirrorAdoption,
  type MirrorAdoption,
} from '../hosted-tasks.ts'
import { rememberHostedInstall } from '../install-binding.ts'
import { projects } from '../projects.ts'
import { persistTaskAdoptions } from '../task-adoption.ts'
import { type HostedTaskIdentity, hostedMirrorTasks, hostedTaskIdentity } from '../task-client.ts'
import { taskProjectDestination } from '../task-project-space.ts'

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
  reportSkipped(): void
}

type CollectorMirrorResult = 'mirrored' | 'not-applicable' | 'unreadable'

/** Load hosted identity once and apply the task project-space rule for one collection pass. */
export async function createCollectorMirrorPass(
  label: 'git' | 'tracker',
): Promise<CollectorMirrorPass> {
  let identity: HostedTaskIdentity | null = null
  let identityError: Error | null = null
  try {
    identity = await hostedTaskIdentity()
    rememberHostedInstall(identity.activeSpaceId)
  } catch (cause) {
    identityError = cause instanceof Error ? cause : new Error(String(cause))
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
    const destinations = new Map<string, T[]>()
    for (const row of rows) {
      if (!identity) {
        skip(row.project_name, 'identity-unreadable', kind)
        continue
      }
      const decision = taskProjectDestination(row.project_name, registered, identity)
      if ('refused' in decision) {
        skip(row.project_name, decision.refused, kind)
        continue
      }
      const selected = destinations.get(decision.destinationSpaceId) ?? []
      selected.push(row)
      destinations.set(decision.destinationSpaceId, selected)
    }
    return destinations
  }

  return {
    async mirrorTasks(rows) {
      const destinations = grouped(rows.map(hostedTaskBody), 'tasks')
      let delivered = false
      for (const [spaceId, selected] of destinations) {
        try {
          const response = await hostedMirrorTasks({ tasks: selected, targetSpaceId: spaceId })
          const adoptions: MirrorAdoption[] = response.adoptions ?? []
          persistTaskAdoptions(adoptions.filter(isTaskMirrorAdoption))
          delivered = true
        } catch (error) {
          for (const project of new Set(selected.map((row) => row.project_name)))
            skip(project, `delivery-failed: ${(error as Error).message}`, 'tasks')
        }
      }
      return delivered ? 'mirrored' : identity ? 'not-applicable' : 'unreadable'
    },
    async mirrorStatusEvents(rows) {
      const destinations = grouped(rows, 'statusEvents')
      let delivered = false
      for (const [spaceId, selected] of destinations) {
        try {
          await hostedMirrorTasks({ tasks: [], statusEvents: selected, targetSpaceId: spaceId })
          delivered = true
        } catch (error) {
          for (const project of new Set(selected.map((row) => row.project_name)))
            skip(project, `delivery-failed: ${(error as Error).message}`, 'statusEvents')
        }
      }
      return delivered ? 'mirrored' : identity ? 'not-applicable' : 'unreadable'
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
