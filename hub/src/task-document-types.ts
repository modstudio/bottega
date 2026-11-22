import type { TaskDocumentRole } from './task-document-role.ts'

export type TaskDocumentSummary = {
  id: string
  number: number
  label: string
  task_key: string
  task_record_id: string
  role: TaskDocumentRole | null
  title: string
  updated_at: string
  body?: string
  version?: string
  created_at?: string
}

export type TaskDocument = TaskDocumentSummary & {
  body: string
  version: string
  created_at: string
}
