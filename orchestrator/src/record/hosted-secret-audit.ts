// concern: hosted-secret-audit
/** Reads declared hosted free-text columns and counts secret-shaped values without retaining evidence. */
import type { SQL } from 'bun'
import { bindTenant } from '../../../shared/record/tenant.ts'
import {
  redactSecretShaped,
  type SecretRulePrecision,
  secretShapedRulePrecision,
} from '../../../shared/secret-shaped.ts'

export type HostedSecretAuditCell = {
  table: string
  column: string
  id?: string
  createdAt?: string
  value: string | null
}

export type HostedSecretAuditCount = {
  table: string
  column: string
  rule: string
  precision: SecretRulePrecision
  count: number
}

export type HostedSecretAuditMatch = {
  table: string
  column: string
  id: string
  createdAt: string
  rule: string
  precision: SecretRulePrecision
}

export type HostedSecretAuditReport = {
  counts: HostedSecretAuditCount[]
  matches: HostedSecretAuditMatch[]
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
  options: { rule?: string } = {},
): HostedSecretAuditCount[] {
  const grouped = new Map<string, HostedSecretAuditCount>()
  for (const cell of cells) {
    if (cell.value === null) continue
    const rules = redactSecretShaped(cell.value, { exemptEvidenceTokens: true }).rules.filter(
      (rule) => options.rule === undefined || rule === options.rule,
    )
    for (const rule of rules) {
      const precision = secretShapedRulePrecision(rule)
      if (!precision) continue
      const key = `${cell.table}\0${cell.column}\0${rule}`
      const existing = grouped.get(key)
      if (existing) existing.count += 1
      else grouped.set(key, { table: cell.table, column: cell.column, rule, precision, count: 1 })
    }
  }
  return [...grouped.values()].toSorted(
    (left, right) =>
      left.table.localeCompare(right.table) ||
      left.column.localeCompare(right.column) ||
      left.rule.localeCompare(right.rule),
  )
}

function auditHostedSecretMatches(
  cells: readonly HostedSecretAuditCell[],
  options: { rule?: string } = {},
): HostedSecretAuditMatch[] {
  return cells.flatMap((cell) => {
    if (cell.value === null || cell.id === undefined || cell.createdAt === undefined) return []
    return redactSecretShaped(cell.value, { exemptEvidenceTokens: true }).rules.flatMap((rule) => {
      if (options.rule !== undefined && rule !== options.rule) return []
      const precision = secretShapedRulePrecision(rule)
      return precision
        ? [
            {
              table: cell.table,
              column: cell.column,
              id: cell.id,
              createdAt: cell.createdAt,
              rule,
              precision,
            },
          ]
        : []
    })
  })
}

async function hostedAuditCells(postgres: SQL): Promise<HostedSecretAuditCell[]> {
  const cells: HostedSecretAuditCell[] = []
  for (const [table, columns] of Object.entries(HOSTED_SECRET_AUDIT_COLUMNS)) {
    for (const column of columns) {
      const rows = await postgres.unsafe(
        `SELECT id::text, created_at::text AS created_at, ${column}::text AS value FROM ${table} WHERE ${column} IS NOT NULL`,
      )
      for (const row of rows as Array<Record<string, unknown>>) {
        cells.push({
          table,
          column,
          id: String(row.id),
          createdAt: String(row.created_at),
          value: typeof row.value === 'string' ? row.value : null,
        })
      }
    }
  }
  return cells
}

export async function auditHostedSecrets(
  postgres: SQL,
  principal: { userId: string; spaceId: string; spaceIds: readonly string[] },
  options: { rule?: string } = {},
): Promise<HostedSecretAuditReport> {
  return postgres.begin(async (tx) => {
    await bindTenant(tx, principal)
    const cells = await hostedAuditCells(tx)
    return {
      counts: auditHostedSecretRows(cells, options),
      matches: auditHostedSecretMatches(cells, options),
    }
  })
}

export function renderHostedSecretAudit(
  counts: readonly HostedSecretAuditCount[],
  matches: readonly HostedSecretAuditMatch[] = [],
): string {
  return [
    ...counts.map(
      (row) => `${row.table}\t${row.column}\t${row.rule}\t${row.precision}\t${row.count}`,
    ),
    ...matches.map(
      (row) =>
        `id\t${row.table}\t${row.column}\t${row.id}\t${row.createdAt}\t${row.rule}\t${row.precision}`,
    ),
    ...HOSTED_SECRET_AUDIT_UNAVAILABLE_COLUMNS.map(
      (row) => `unavailable\t${row.table}\t${row.column}`,
    ),
  ].join('\n')
}
