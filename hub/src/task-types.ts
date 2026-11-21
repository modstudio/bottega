export type TaskComment = {
  id: string
  task_key: string
  task_record_id: string
  body: string
  created_at: string
  actor_user_id: string | null
  actor_name: string | null
  agent: string | null
  run_id: string | null
  updated_at: string | null
  deleted_at: string | null
  revision?: number
}

export type TaskChanges = {
  title?: string
  status?: string
  parent?: string | null
  body?: string
  assignee?: string | null
}

export type HostedTaskLookupRow = {
  record_id: string
  key: string
  project: string
  title: string | null
  parent_key: string | null
  status: string | null
  status_category: string | null
  opened_at: string | null
  last_seen: string | null
  has_children: boolean
}
