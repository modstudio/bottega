import { PLATFORM_NAME } from '../../shared/brand.ts'
import type { HostedWriteMode } from './hosted-write-mode.ts'
import {
  HOSTED_COMMENT_TABLE,
  HOSTED_DOCUMENT_TABLE,
  HOSTED_STATUS_EVENT_TABLE,
  HOSTED_TASK_TABLE,
  PUSHABLE_HUB_CHANGE_TABLES,
  SYNCED_HUB_CHANGE_TABLES,
} from './push-contract.ts'

const GUARDED_HOSTED_TABLES: ReadonlySet<string> = new Set(
  PUSHABLE_HUB_CHANGE_TABLES.filter((table) => !SYNCED_HUB_CHANGE_TABLES.has(table)),
)

const note = PLATFORM_NAME.toLowerCase()

export const OFFLINE_TASK_EDITS_DOCUMENT_DELETE_QUEUE_SITE =
  'offline-task-edits.queueHostedDocumentDelete'
export const TRACKERS_RETIRE_OUT_OF_SCOPE_QUEUE_SITE = 'trackers.retireOutOfScopeTrackerTasks'
export const TRACKERS_BACKFILL_QUEUE_SITE = 'trackers.backfillTrackerTasks'
export const TRACKERS_WRITE_CACHE_QUEUE_SITE = 'trackers.writeTrackerCache'
export const TRACKERS_DROP_DELETED_QUEUE_SITE = 'trackers.dropDeletedTrackerTasks'
export const TASK_PUSH_REPAIRS_QUEUE_SITE = 'task-push.queueRepairs'

export const HOSTED_QUEUE_ALLOWLIST = [
  {
    site: OFFLINE_TASK_EDITS_DOCUMENT_DELETE_QUEUE_SITE,
    table: HOSTED_DOCUMENT_TABLE,
    removedBy: 'DEV-2527',
  },
  {
    site: TRACKERS_RETIRE_OUT_OF_SCOPE_QUEUE_SITE,
    table: HOSTED_TASK_TABLE,
    removedBy: `note ${note}#2924`,
  },
  {
    site: TRACKERS_BACKFILL_QUEUE_SITE,
    table: HOSTED_TASK_TABLE,
    removedBy: `note ${note}#2924`,
  },
  ...[HOSTED_TASK_TABLE, HOSTED_STATUS_EVENT_TABLE].flatMap((table) => [
    { site: TRACKERS_WRITE_CACHE_QUEUE_SITE, table, removedBy: `note ${note}#2924` },
    { site: TRACKERS_DROP_DELETED_QUEUE_SITE, table, removedBy: `note ${note}#2924` },
  ]),
  ...[
    HOSTED_TASK_TABLE,
    HOSTED_COMMENT_TABLE,
    HOSTED_DOCUMENT_TABLE,
    HOSTED_STATUS_EVENT_TABLE,
  ].map((table) => ({ site: TASK_PUSH_REPAIRS_QUEUE_SITE, table, removedBy: `note ${note}#2925` })),
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
  if (mode !== 'hosted-configured' || !GUARDED_HOSTED_TABLES.has(table)) return null
  if (site && HOSTED_QUEUE_ALLOWLIST.some((entry) => entry.table === table && entry.site === site))
    return null
  return `${table} at ${site ?? '(unlabeled site)'} cannot be queued in hosted-configured mode; hosted tables go straight to the record through sendHostedChanges`
}
