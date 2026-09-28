// concern: outbox-secret-audit
/** Counts secret-shaped free-text leaves in local outbox payloads. Must not print matched text. */
import type { Database } from 'bun:sqlite'
import { firstOutboxEvidenceRule } from './outbox-sanitize.ts'

type OutboxSecretAuditStatus = 'synced' | 'pending' | 'quarantined' | 'retired'

export type OutboxSecretAuditCount = {
  kind: string
  rule: string
  status: OutboxSecretAuditStatus
  count: number
  ids?: number[]
}

type OutboxAuditRow = {
  id: number
  kind: string
  payload: string
  synced_at: string | null
  quarantined_at: string | null
  retired_at: string | null
}

function outboxStatus(row: OutboxAuditRow): OutboxSecretAuditStatus {
  if (row.retired_at) return 'retired'
  if (row.quarantined_at) return 'quarantined'
  if (row.synced_at) return 'synced'
  return 'pending'
}

function parseOutboxObject(payload: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(payload)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function unreadableOutboxAuditMessage(ids: number[], includeIds: boolean): string {
  const named = includeIds ? ` (outbox ids ${ids.join(',')})` : ''
  const clear = includeIds
    ? 'repair the stored JSON or retire those rows with orch record outbox retire'
    : 'rerun with --ids to name the unreadable rows, then repair their stored JSON or retire them with orch record outbox retire'
  return (
    `refusing outbox secret audit: ${ids.length} rows were unreadable${named}\n` +
    'invariant: An audit never reports emptiness for rows it could not read.\n' +
    `cleared by: ${clear}`
  )
}

export function auditOutboxSecrets(
  database: Database,
  options: { ids: boolean } = { ids: false },
): { counts: OutboxSecretAuditCount[] } {
  const rows = database
    .query<OutboxAuditRow, []>(
      `SELECT id, kind, payload, synced_at, quarantined_at, retired_at FROM outbox ORDER BY id`,
    )
    .all()
  const grouped = new Map<string, OutboxSecretAuditCount>()
  const unreadable: number[] = []
  for (const row of rows) {
    const parsed = parseOutboxObject(row.payload)
    if (parsed === null) {
      unreadable.push(row.id)
      continue
    }
    const rule = firstOutboxEvidenceRule(row.kind, parsed)
    if (!rule) continue
    const status = outboxStatus(row)
    const key = `${row.kind}\0${rule}\0${status}`
    const existing = grouped.get(key)
    if (existing) {
      existing.count += 1
      existing.ids?.push(row.id)
      continue
    }
    grouped.set(key, {
      kind: row.kind,
      rule,
      status,
      count: 1,
      ...(options.ids ? { ids: [row.id] } : {}),
    })
  }
  if (unreadable.length > 0) throw new Error(unreadableOutboxAuditMessage(unreadable, options.ids))
  return {
    counts: [...grouped.values()].toSorted(
      (left, right) =>
        left.kind.localeCompare(right.kind) ||
        left.rule.localeCompare(right.rule) ||
        left.status.localeCompare(right.status),
    ),
  }
}

export function renderOutboxSecretAudit(report: { counts: OutboxSecretAuditCount[] }): string {
  return report.counts
    .map((row) => {
      const ids = row.ids ? `\t${row.ids.join(',')}` : ''
      return `${row.kind}\t${row.rule}\t${row.status}\t${row.count}${ids}`
    })
    .join('\n')
}
