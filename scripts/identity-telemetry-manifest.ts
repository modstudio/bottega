import type { ManifestColumn } from './identity-inventory.ts'

const columns = (reason: string, names: readonly string[]): ManifestColumn[] =>
  names.map((column) => ({ store: 'orchestrator', column, reason }))

export const TELEMETRY_IDENTITY = {
  values: columns('daily contention aggregate measurement', [
    'contention_day.event_count',
    'contention_day.total_duration_ms',
  ]),
  externalIdentifiers: columns('identifier copied into a machine telemetry rollup', [
    'contention_day.resource_key',
    'contention_day.session_id',
    'monitor_issue.issue_key',
  ]),
  uuids: columns('owned UUID row identity', [
    'contention_day.record_id',
    'monitor_issue.record_id',
  ]),
} as const
