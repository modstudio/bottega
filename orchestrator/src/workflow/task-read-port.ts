// concern: workflows
/** Provides in-process access to the hub task read model installed by the CLI entrypoint. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'

export type TaskReadRow = {
  key: string
  record_id: string
  project: string
  title?: string | null
  parent_key?: string | null
  source?: string | null
  status?: string | null
  status_category?: string | null
  last_seen?: string | null
}

export type TaskReadDocumentSummary = {
  id: string
  label: string
  title: string
  role?: string | null
}

export type TaskReadDocument = TaskReadDocumentSummary & {
  body: string
  version: string
}

export type TaskReadShow = {
  task: TaskReadRow
  comments?: { body?: unknown }[]
  documents?: TaskReadDocumentSummary[]
}

export type TaskReadPort = {
  list(filters?: { project?: string; status?: string; parent?: string }): TaskReadRow[]
  show(key: string, scope?: { project?: string; recordId?: string }): TaskReadShow
  documents(key: string, scope?: { project?: string; recordId?: string }): TaskReadDocumentSummary[]
  document(value: string, scope?: { project?: string; recordId?: string }): TaskReadDocument
}

let installedTaskReader: TaskReadPort | undefined

/** Install the task reader used by every orchestrator read in this process. */
export function installTaskReader(port: TaskReadPort): void {
  installedTaskReader = port
}

/** Refuse instead of silently falling back to a CLI spawn. */
export function taskReader(): TaskReadPort {
  if (!installedTaskReader) {
    throw new Error(
      `task reads are unavailable: this process did not install a task reader; start it through bin/${PLATFORM_SLUG}`,
    )
  }
  return installedTaskReader
}
