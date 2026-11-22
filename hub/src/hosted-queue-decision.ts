import type { HostedWriteMode } from './hosted-write-mode.ts'
import {
  HOSTED_DOCUMENT_TABLE,
  PUSHABLE_HUB_CHANGE_TABLES,
  SYNCED_HUB_CHANGE_TABLES,
} from './push-contract.ts'

const GUARDED_HOSTED_TABLES: ReadonlySet<string> = new Set(
  PUSHABLE_HUB_CHANGE_TABLES.filter((table) => !SYNCED_HUB_CHANGE_TABLES.has(table)),
)

export const OFFLINE_TASK_EDITS_DOCUMENT_DELETE_QUEUE_SITE =
  'offline-task-edits.queueHostedDocumentDelete'

export const HOSTED_QUEUE_ALLOWLIST = [
  {
    site: OFFLINE_TASK_EDITS_DOCUMENT_DELETE_QUEUE_SITE,
    table: HOSTED_DOCUMENT_TABLE,
    removedBy: 'DEV-2527',
  },
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
