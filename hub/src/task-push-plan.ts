import type { HostedTaskIdentity } from './task-client.ts'
import { type RegisteredTaskSpace, taskProjectDestination } from './task-project-space.ts'

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
  identity: HostedTaskIdentity,
) {
  const decisions = new Map(
    [
      ...new Set(Object.values(rows).flatMap((values) => values.map((row) => row.project_name))),
    ].map((project) => [project, taskProjectDestination(project, registered, identity)] as const),
  )
  const destinations = new Map<string, TaskPushDestination>()
  const refused = new Map<string, PushIssue>()
  for (const [name, values] of Object.entries(rows) as Array<
    [keyof PushCollections, PushCollections[keyof PushCollections]]
  >) {
    for (const row of values) {
      const decision = decisions.get(row.project_name)!
      if ('refused' in decision) {
        const issue =
          refused.get(row.project_name) ?? emptyIssue(row.project_name, decision.refused)
        issue[name]++
        refused.set(row.project_name, issue)
        continue
      }
      const destination = destinations.get(decision.destinationSpaceId) ?? {
        spaceId: decision.destinationSpaceId,
        projects: [],
        rows: emptyRows(),
      }
      if (!destination.projects.includes(row.project_name))
        destination.projects.push(row.project_name)
      ;(destination.rows[name] as Array<typeof row>).push(row)
      destinations.set(destination.spaceId, destination)
    }
  }
  return {
    destinations: [...destinations.values()]
      .map((destination) => ({ ...destination, projects: destination.projects.sort() }))
      .sort((a, b) => a.spaceId.localeCompare(b.spaceId)),
    refused: [...refused.values()].sort((a, b) => a.project.localeCompare(b.project)),
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
