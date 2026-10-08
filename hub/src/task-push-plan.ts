import {
  partitionProjectRows,
  type RegisteredTaskSpace,
  type TaskDestinationIdentity,
} from './task-project-space.ts'

export type PushCollections = {
  tasks: Array<
    Record<string, unknown> & {
      key: string
      project: string
      project_name: string
      source: string
      newly_assigned?: boolean
    }
  >
  comments: Array<Record<string, unknown> & { task_key: string; project_name: string }>
  documents: Array<Record<string, unknown> & { task_key: string; project_name: string }>
  statusEvents: Array<Record<string, unknown> & { task_key: string; project_name: string }>
}

export type PushIssue = {
  project: string
  reason: string
  tasks: number
  comments: number
  documents: number
  statusEvents: number
}

export type TaskPushDestination = {
  spaceId: string
  projects: string[]
  rows: PushCollections
}

const emptyRows = (): PushCollections => ({
  tasks: [],
  comments: [],
  documents: [],
  statusEvents: [],
})
const emptyIssue = (project: string, reason: string): PushIssue => ({
  project,
  reason,
  tasks: 0,
  comments: 0,
  documents: 0,
  statusEvents: 0,
})

/** Partition every task mirror row by its project's resolved destination. */
export function planTaskPush(
  rows: PushCollections,
  registered: readonly RegisteredTaskSpace[],
  identity: TaskDestinationIdentity,
) {
  const tagged = (
    Object.entries(rows) as Array<[keyof PushCollections, PushCollections[keyof PushCollections]]>
  ).flatMap(([name, values]) =>
    values.map((row) => ({ name, row, project_name: row.project_name })),
  )
  const partitioned = partitionProjectRows(tagged, registered, identity)
  const destinations = new Map<string, TaskPushDestination>()
  for (const [spaceId, selected] of partitioned.destinations) {
    const destination = destinations.get(spaceId) ?? {
      spaceId,
      projects: [],
      rows: emptyRows(),
    }
    for (const { name, row } of selected) {
      if (!destination.projects.includes(row.project_name))
        destination.projects.push(row.project_name)
      ;(destination.rows[name] as Array<typeof row>).push(row)
    }
    destinations.set(spaceId, destination)
  }
  const refused = [...partitioned.refusals].map(([project, refusal]) => {
    const issue = emptyIssue(project, refusal.reason)
    for (const { name } of refusal.rows) issue[name]++
    return issue
  })
  return {
    destinations: [...destinations.values()]
      .map((destination) => ({ ...destination, projects: destination.projects.sort() }))
      .sort((a, b) => a.spaceId.localeCompare(b.spaceId)),
    refused: refused.sort((a, b) => a.project.localeCompare(b.project)),
  }
}

export function issueForDestination(destination: TaskPushDestination, reason: string): PushIssue[] {
  return destination.projects.map((project) => {
    const issue = emptyIssue(project, reason)
    for (const [name, rows] of Object.entries(destination.rows) as Array<
      [keyof PushCollections, PushCollections[keyof PushCollections]]
    >)
      issue[name] = rows.filter((row) => row.project_name === project).length
    return issue
  })
}
