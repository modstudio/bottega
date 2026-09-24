import { type HostedTask, isTaskMirrorAdoption, type MirrorAdoption } from '../hosted-tasks.ts'
import { persistTaskAdoptions } from '../task-adoption.ts'
import { hostedMirrorTasks } from '../task-client.ts'

export type CollectedTaskRow = Pick<
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

export async function mirrorCollectedTasks(rows: readonly CollectedTaskRow[]) {
  const response = await hostedMirrorTasks({ tasks: rows.map(hostedTaskBody) })
  const adoptions: MirrorAdoption[] = response.adoptions ?? []
  persistTaskAdoptions(adoptions.filter(isTaskMirrorAdoption))
  return response
}
