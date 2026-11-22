// concern: hosted-secret-audit
/** Reads declared hosted free-text columns and counts secret-shaped values without retaining evidence. */
import type { SQL } from 'bun'
import { bindTenant } from '../../../shared/record/tenant.ts'
import { redactSecretShaped } from '../../../shared/secret-shaped.ts'

export type HostedSecretAuditCell = {
  table: string
  column: string
  value: string | null
}

export type HostedSecretAuditCount = {
  table: string
  column: string
  rule: string
  count: number
}

const HOSTED_SECRET_AUDIT_COLUMNS = {
  hub_note: ['text', 'area', 'stale_reason', 'anchors'],
  hub_task: ['title', 'body'],
  hub_task_comment: ['body'],
  hub_task_document: ['title', 'body'],
  context_item: ['body', 'source', 'target'],
  question: ['question', 'answer', 'answer_basis', 'replacement', 'overturn_reason'],
  workflow_step_text: ['body'],
  workflow_version: ['definition', 'author', 'reason'],
  board_message: ['body'],
  board_message_tag: ['value'],
  doc: ['title', 'body'],
  doc_revision: ['title', 'body'],
} as const

export const HOSTED_SECRET_AUDIT_UNAVAILABLE_COLUMNS = [
  { table: 'question', column: 'reason' },
  { table: 'question', column: 'text' },
  { table: 'workflow_text_copy', column: 'text' },
] as const

export function auditHostedSecretRows(
  cells: readonly HostedSecretAuditCell[],
): HostedSecretAuditCount[] {
  const grouped = new Map<string, HostedSecretAuditCount>()
  for (const cell of cells) {
    if (cell.value === null) continue
    const rule = redactSecretShaped(cell.value, { exemptEvidenceTokens: true }).rules[0]
    if (!rule) continue
    const key = `${cell.table}\0${cell.column}\0${rule}`
    const existing = grouped.get(key)
    if (existing) existing.count += 1
    else grouped.set(key, { table: cell.table, column: cell.column, rule, count: 1 })
  }
  return [...grouped.values()].toSorted(
    (left, right) =>
      left.table.localeCompare(right.table) ||
      left.column.localeCompare(right.column) ||
      left.rule.localeCompare(right.rule),
  )
}

async function hostedAuditCells(postgres: SQL): Promise<HostedSecretAuditCell[]> {
  const cells: HostedSecretAuditCell[] = []
  for (const [table, columns] of Object.entries(HOSTED_SECRET_AUDIT_COLUMNS)) {
    for (const column of columns) {
      const rows = await postgres.unsafe(
        `SELECT ${column}::text AS value FROM ${table} WHERE ${column} IS NOT NULL`,
      )
      for (const row of rows as Array<Record<string, unknown>>) {
        cells.push({ table, column, value: typeof row.value === 'string' ? row.value : null })
      }
    }
  }
  return cells
}

export async function auditHostedSecrets(
  postgres: SQL,
  principal: { userId: string; spaceId: string; spaceIds: readonly string[] },
): Promise<HostedSecretAuditCount[]> {
  return postgres.begin(async (tx) => {
    await bindTenant(tx, principal)
    return auditHostedSecretRows(await hostedAuditCells(tx))
  })
}

export function renderHostedSecretAudit(counts: readonly HostedSecretAuditCount[]): string {
  return [
    ...counts.map((row) => `${row.table}\t${row.column}\t${row.rule}\t${row.count}`),
    ...HOSTED_SECRET_AUDIT_UNAVAILABLE_COLUMNS.map(
      (row) => `unavailable\t${row.table}\t${row.column}`,
    ),
  ].join('\n')
}
