import type { HostedWriteMode } from './hosted-write-mode.ts'
import { PUSHABLE_HUB_CHANGE_TABLES, SYNCED_HUB_CHANGE_TABLES } from './push-contract.ts'

const GUARDED_HOSTED_TABLES: ReadonlySet<string> = new Set(
  PUSHABLE_HUB_CHANGE_TABLES.filter((table) => !SYNCED_HUB_CHANGE_TABLES.has(table)),
)

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
  return `${table} at ${site ?? '(unlabeled site)'} cannot be queued in hosted-configured mode; hosted tables go straight to the record through sendHostedChanges`
}
