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
  for (const row of rows) {
    let parsed: unknown
    try {
      parsed = JSON.parse(row.payload)
    } catch {
      continue
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const rule = firstOutboxEvidenceRule(row.kind, parsed as Record<string, unknown>)
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
