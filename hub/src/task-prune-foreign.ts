import type { HostedTaskPresencePair } from './hosted-task-prune.ts'
import type { HostedTask } from './hosted-tasks.ts'
import { projects } from './projects.ts'
import {
  hostedDeleteTasks,
  hostedListTasks,
  hostedTaskIdentity,
  hostedTaskPresence,
  type TaskFetch,
} from './task-client.ts'
import { type RegisteredTaskSpace, taskProjectSpaceDisposition } from './task-project-space.ts'

export type ForeignHostedTask = Pick<HostedTask, 'id' | 'key' | 'project' | 'source'> & {
  present_elsewhere: boolean | null
  target_space_id: string | null
}

export function selectForeignHostedTasks(
  tasks: readonly HostedTask[],
  registered: readonly RegisteredTaskSpace[],
  identity: Awaited<ReturnType<typeof hostedTaskIdentity>>,
  present: readonly HostedTaskPresencePair[],
  filters: { project?: string; onlyPresentElsewhere?: boolean } = {},
): ForeignHostedTask[] {
  const existing = new Set(present.map((pair) => `${pair.space_id}\0${pair.key}`))
  return tasks.flatMap((task) => {
    if (task.deleted_at || (filters.project && task.project !== filters.project)) return []
    const disposition = taskProjectSpaceDisposition(task.project, registered, identity)
    if (disposition.belongsToActiveSpace) return []
    const presentElsewhere = disposition.targetSpaceId
      ? existing.has(`${disposition.targetSpaceId}\0${task.key}`)
      : null
    if (filters.onlyPresentElsewhere && presentElsewhere !== true) return []
    return [
      {
        id: task.id,
        key: task.key,
        project: task.project,
        source: task.source,
        present_elsewhere: presentElsewhere,
        target_space_id: disposition.targetSpaceId,
      },
    ]
  })
}

export function confirmForeignTaskPrune(count: number, confirmation?: number) {
  if (confirmation !== count)
    throw new Error(`refusing to prune ${count} tasks without --confirm ${count}`)
}

type Options = {
  dryRun?: boolean
  confirmation?: number
  project?: string
  onlyPresentElsewhere?: boolean
  baseUrl?: string
  token?: string | null
  fetch?: TaskFetch
}

export async function pruneForeignHostedTasks(options: Options = {}) {
  const request = { baseUrl: options.baseUrl, token: options.token, fetch: options.fetch }
  const identity = await hostedTaskIdentity(request)
  const active = await hostedListTasks(request)
  const preliminary = selectForeignHostedTasks(active.tasks, projects(), identity, [])
  const pairs = preliminary.flatMap((task) =>
    task.target_space_id ? [{ space_id: task.target_space_id, key: task.key }] : [],
  )
  const presence = pairs.length
    ? await hostedTaskPresence(pairs, request)
    : { present: [], refused: [] }
  const selected = selectForeignHostedTasks(active.tasks, projects(), identity, presence.present, {
    project: options.project,
    onlyPresentElsewhere: options.onlyPresentElsewhere,
  })
  if (options.dryRun)
    return { active_space_id: identity.activeSpaceId, tasks: selected, deleted: null }
  confirmForeignTaskPrune(selected.length, options.confirmation)
  const deleted = await hostedDeleteTasks(
    selected.map((task) => task.id),
    options.confirmation,
    request,
  )
  return { active_space_id: identity.activeSpaceId, tasks: selected, deleted }
}
