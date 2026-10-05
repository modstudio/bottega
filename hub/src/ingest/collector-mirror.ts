import {
  type HostedStatusEvent,
  type HostedTask,
  isMirrorExpectedSpaceMismatch,
  isTaskMirrorAdoption,
  type MirrorAdoption,
} from '../hosted-tasks.ts'
import { installBindingFromIdentity, rememberHostedInstall } from '../install-binding.ts'
import { projects } from '../projects.ts'
import { persistTaskAdoptions } from '../task-adoption.ts'
import { type HostedTaskIdentity, hostedMirrorTasks, hostedTaskIdentity } from '../task-client.ts'
import { taskProjectSpaceDisposition } from '../task-project-space.ts'

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
type CollectorMirrorSkipReason = 'unmapped' | 'different-space' | 'identity-unreadable'

type CollectorMirrorSkip = {
  project: string
  reason: CollectorMirrorSkipReason
  tasks: number
  statusEvents: number
}

export type CollectorMirrorPass = {
  mirrorTasks(rows: readonly CollectedTaskRow[]): Promise<CollectorMirrorResult>
  mirrorStatusEvents(rows: readonly HostedStatusEvent[]): Promise<CollectorMirrorResult>
  reportSkipped(): void
}

export type CollectorMirrorResult = 'mirrored' | 'not-applicable' | 'unreadable'

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
  const skip = (project: string, reason: CollectorMirrorSkipReason, kind: CollectorMirrorKind) => {
    const key = `${project}\0${reason}`
    const entry = skipped.get(key) ?? { project, reason, tasks: 0, statusEvents: 0 }
    entry[kind]++
    skipped.set(key, entry)
  }
  const select = <T extends { project_name: string }>(
    rows: readonly T[],
    kind: CollectorMirrorKind,
  ) =>
    rows.filter((row) => {
      if (!identity) {
        skip(row.project_name, 'identity-unreadable', kind)
        return false
      }
      const disposition = taskProjectSpaceDisposition(
        row.project_name,
        registered,
        identity,
        installBindingFromIdentity(identity),
      )
      if (disposition.belongsToActiveSpace) return true
      skip(row.project_name, disposition.reason, kind)
      return false
    })

  const refuseChangedSpace = <T extends { project_name: string }>(
    error: unknown,
    rows: readonly T[],
    kind: CollectorMirrorKind,
  ) => {
    if (!isMirrorExpectedSpaceMismatch(error)) return false
    identity = null
    identityError = error instanceof Error ? error : new Error(String(error))
    for (const row of rows) skip(row.project_name, 'identity-unreadable', kind)
    return true
  }

  return {
    async mirrorTasks(rows) {
      const selected = select(rows.map(hostedTaskBody), 'tasks')
      if (!selected.length) return identity ? 'not-applicable' : 'unreadable'
      try {
        const response = await hostedMirrorTasks({
          tasks: selected,
          expectedSpaceId: identity!.activeSpaceId,
        })
        const adoptions: MirrorAdoption[] = response.adoptions ?? []
        persistTaskAdoptions(adoptions.filter(isTaskMirrorAdoption))
        return 'mirrored'
      } catch (error) {
        if (refuseChangedSpace(error, selected, 'tasks')) return 'unreadable'
        throw error
      }
    },
    async mirrorStatusEvents(rows) {
      const selected = select(rows, 'statusEvents')
      if (!selected.length) return identity ? 'not-applicable' : 'unreadable'
      try {
        await hostedMirrorTasks({
          tasks: [],
          statusEvents: selected,
          expectedSpaceId: identity!.activeSpaceId,
        })
        return 'mirrored'
      } catch (error) {
        if (refuseChangedSpace(error, selected, 'statusEvents')) return 'unreadable'
        throw error
      }
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
