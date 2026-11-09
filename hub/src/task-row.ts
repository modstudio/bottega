import type { TaskSource } from '../../shared/task-source.ts'
import type { StatusCategory } from '../../shared/trackers.ts'

/** The canonical local task row shared by task storage adapters. */
export type TaskRow = {
  record_id: string
  external_id: string | null
  key: string
  project: string
  project_record_id?: string | null
  title: string | null
  status: string | null
  status_category: StatusCategory | null
  parent_key: string | null
  parent_record_id: string | null
  body: string | null
  assignee: string | null
  opened_at: string | null
  closed_at: string | null
  updated_at: string | null
  source: TaskSource
  first_seen: string
  last_seen: string
  next_document_number: number
  retired_reason: string | null
}
