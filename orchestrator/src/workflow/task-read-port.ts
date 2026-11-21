// concern: workflows
/** Provides in-process access to the task read model installed by the CLI entrypoint. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'

export type TaskReadRow = {
  key: string
  record_id: string
  project: string
  title: string | null
  parent_key: string | null
  source: string | null
  status: string | null
  status_category: string | null
  last_seen: string | null
  body: string | null
  opened_at: string | null
  has_children?: boolean
}

type TaskLookupRow = Omit<TaskReadRow, 'source' | 'body'>

type TaskReadDocumentSummary = {
  id: string
  label: string
  task_record_id: string
  title: string
  role?: string | null
}

type TaskReadDocument = TaskReadDocumentSummary & {
  body: string
  version: string
}

type TaskReadShow = {
  task: TaskReadRow
  comments?: { body?: unknown }[]
  documents?: TaskReadDocumentSummary[]
}

type TaskReadDuplicateCandidate = {
  key: string
  status: string | null
  title: string
  score: number
}

export type TaskReadPort = {
  list(filters?: { project?: string; status?: string; parent?: string }): Promise<TaskReadRow[]>
  lookup(project: string, keys: string[]): Promise<TaskLookupRow[]>
  duplicates(project: string, title: string): Promise<TaskReadDuplicateCandidate[]>
  show(key: string, scope?: { project?: string; recordId?: string }): Promise<TaskReadShow>
  documents(
    key: string,
    scope?: { project?: string; recordId?: string },
  ): Promise<TaskReadDocumentSummary[]>
  document(
    value: string,
    scope?: { project?: string; recordId?: string },
  ): Promise<TaskReadDocument>
}

let installedTaskReader: TaskReadPort | undefined

/** Install the task reader used by every orchestrator read in this process. */
export function installTaskReader(port: TaskReadPort): void {
  installedTaskReader = port
}

/** Refuse instead of silently falling back to a CLI spawn. */
export function taskReader(): TaskReadPort {
  if (!installedTaskReader) {
    const entrypoint = bottegaEntryArgv(PLATFORM_SLUG)[0]!
    throw new Error(
      `task reads are unavailable: this process did not install a task reader; start it through ${entrypoint}`,
    )
  }
  return installedTaskReader
}
