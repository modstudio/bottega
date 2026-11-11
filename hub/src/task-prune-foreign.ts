import type { HostedTaskPresencePair } from './hosted-task-prune.ts'
import { confirmCount, type HostedTask } from './hosted-tasks.ts'
import { rememberHostedInstall } from './install-binding.ts'
import { projects } from './projects.ts'
import {
  hostedDeleteTasks,
  hostedListTasks,
  hostedTaskIdentity,
  hostedTaskPresence,
  type TaskFetch,
} from './task-client.ts'
import { type RegisteredTaskSpace, taskProjectDestination } from './task-project-space.ts'

export type ForeignHostedTask = Pick<HostedTask, 'id' | 'key' | 'project' | 'source'> & {
  present_elsewhere: boolean | null
  target_space_id: string | null
}

export function selectForeignHostedTasks(
  tasks: readonly HostedTask[],
  registered: readonly RegisteredTaskSpace[],
  identity: Awaited<ReturnType<typeof hostedTaskIdentity>>,
  present: readonly HostedTaskPresencePair[],
  space: string,
  filters: { project?: string; onlyPresentElsewhere?: boolean } = {},
): ForeignHostedTask[] {
  const existing = new Set(present.map((pair) => `${pair.space_id}\0${pair.key}`))
  return tasks.flatMap((task) => {
    if (task.deleted_at || (filters.project && task.project !== filters.project)) return []
    const destination = taskProjectDestination(task.project, registered, identity)
    if ('destinationSpaceId' in destination && destination.destinationSpaceId === space) return []
    const targetSpaceId =
      'destinationSpaceId' in destination ? destination.destinationSpaceId : null
    const presentElsewhere = targetSpaceId ? existing.has(`${targetSpaceId}\0${task.key}`) : null
    if (filters.onlyPresentElsewhere && presentElsewhere !== true) return []
    return [
      {
        id: task.id,
        key: task.key,
        project: task.project,
        source: task.source,
        present_elsewhere: presentElsewhere,
        target_space_id: targetSpaceId,
      },
    ]
  })
}

type Options = {
  space?: string
  dryRun?: boolean
  confirmation?: number
  project?: string
  onlyPresentElsewhere?: boolean
  baseUrl?: string
  token?: string | null
  fetch?: TaskFetch
}

export async function pruneForeignHostedTasks(options: Options = {}) {
  if (!options.space?.trim())
    throw new Error('prune-foreign names no hosted space; pass --space <id> and retry')
  const request = { baseUrl: options.baseUrl, token: options.token, fetch: options.fetch }
  const targeted = { ...request, recordSpace: options.space }
  const identity = await hostedTaskIdentity(request)
  rememberHostedInstall(identity.activeSpaceId)
  const active = await hostedListTasks(targeted)
  const preliminary = selectForeignHostedTasks(
    active.tasks,
    projects(),
    identity,
    [],
    options.space,
  )
  const pairs = preliminary.flatMap((task) =>
    task.target_space_id ? [{ space_id: task.target_space_id, key: task.key }] : [],
  )
  const presence = pairs.length
    ? await hostedTaskPresence(pairs, targeted)
    : { present: [], refused: [] }
  const selected = selectForeignHostedTasks(
    active.tasks,
    projects(),
    identity,
    presence.present,
    options.space,
    {
      project: options.project,
      onlyPresentElsewhere: options.onlyPresentElsewhere,
    },
  )
  if (options.dryRun) return { space_id: options.space, tasks: selected, deleted: null }
  confirmCount(selected.length, options.confirmation, 'exact-always')
  const deleted = await hostedDeleteTasks(
    selected.map((task) => task.id),
    options.confirmation,
    targeted,
  )
  return { space_id: options.space, tasks: selected, deleted }
}
