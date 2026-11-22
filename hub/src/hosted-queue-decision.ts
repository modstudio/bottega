import { PLATFORM_NAME } from '../../shared/brand.ts'
import type { HostedWriteMode } from './hosted-write-mode.ts'
import {
  HOSTED_COMMENT_TABLE,
  HOSTED_DOCUMENT_TABLE,
  HOSTED_STATUS_EVENT_TABLE,
  HOSTED_TASK_TABLE,
} from './push-contract.ts'

const HOSTED_RECORD_TABLES: ReadonlySet<string> = new Set([
  HOSTED_TASK_TABLE,
  HOSTED_COMMENT_TABLE,
  HOSTED_DOCUMENT_TABLE,
  HOSTED_STATUS_EVENT_TABLE,
])

const note = PLATFORM_NAME.toLowerCase()

export const HOSTED_QUEUE_ALLOWLIST = [
  {
    site: 'offline-task-edits.queueHostedDocumentDelete',
    table: HOSTED_DOCUMENT_TABLE,
    removedBy: 'DEV-2527',
  },
  {
    site: 'trackers.retireOutOfScopeTrackerTasks',
    table: HOSTED_TASK_TABLE,
    removedBy: `note ${note}#2924`,
  },
  {
    site: 'trackers.backfillTrackerTasks',
    table: HOSTED_TASK_TABLE,
    removedBy: `note ${note}#2924`,
  },
  ...[HOSTED_TASK_TABLE, HOSTED_COMMENT_TABLE, HOSTED_DOCUMENT_TABLE, HOSTED_STATUS_EVENT_TABLE].map(
    (table) => ({ site: 'task-push.queueRepairs', table, removedBy: `note ${note}#2925` }),
  ),
] as const

export function hostedQueueRefusal({
  table,
  mode,
  site,
}: {
  table: string
  mode: HostedWriteMode
  site?: string
}): string | null {
  if (mode !== 'hosted-configured' || !HOSTED_RECORD_TABLES.has(table)) return null
  if (site && HOSTED_QUEUE_ALLOWLIST.some((entry) => entry.table === table && entry.site === site))
    return null
  return `${table} at ${site ?? '(unlabeled site)'} cannot be queued in hosted-configured mode; hosted tables go straight to the record through sendHostedChanges`
}
