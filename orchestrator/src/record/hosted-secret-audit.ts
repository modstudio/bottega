// concern: hosted-secret-audit
/** Reads declared hosted free-text columns and counts secret-shaped values without retaining evidence. */
import type { SQL } from 'bun'
import { getTableColumns, getTableName, type Table } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { boardMessage, boardMessageTag } from '../../../shared/record/schema-board.ts'
import { contextItem } from '../../../shared/record/schema-context-items.ts'
import { doc, docRevision } from '../../../shared/record/schema-docs.ts'
import {
  hubNote,
  hubTask,
  hubTaskComment,
  hubTaskDocument,
} from '../../../shared/record/schema-hub.ts'
import { question } from '../../../shared/record/schema-question.ts'
import { workflowStepText } from '../../../shared/record/schema-task-flow.ts'
import { workflowTextCopy } from '../../../shared/record/schema-task-flow.ts'
import {
  stepCatalogueEvent,
  stepCatalogueVersion,
  workflowEvent,
  workflowVersion,
} from '../../../shared/record/schema-workflow-catalogue.ts'
import { bindTenant } from '../../../shared/record/tenant.ts'
import { isHostedAuditColumnExcluded } from '../../../shared/hosted-secret-mask.ts'
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

type HostedSecretAuditSchemaEntry = {
  table: Table
  id: AnyPgColumn
  timestamp: AnyPgColumn | null
  columns: readonly AnyPgColumn[]
}

const auditTable = (table: Table, id: AnyPgColumn, timestamp: AnyPgColumn | null) => ({
  table,
  id,
  timestamp,
})

/** One table inventory; scanned columns are derived from these Drizzle schema objects. */
export const HOSTED_SECRET_AUDIT_TABLES = [
  auditTable(hubNote, hubNote.id, hubNote.createdAt),
  auditTable(hubTask, hubTask.id, hubTask.createdAt),
  auditTable(hubTaskComment, hubTaskComment.id, hubTaskComment.createdAt),
  auditTable(hubTaskDocument, hubTaskDocument.id, hubTaskDocument.createdAt),
  auditTable(contextItem, contextItem.id, contextItem.createdAt),
  auditTable(question, question.id, question.createdAt),
  auditTable(workflowStepText, workflowStepText.id, workflowStepText.createdAt),
  auditTable(workflowTextCopy, workflowTextCopy.id, null),
  auditTable(workflowVersion, workflowVersion.id, workflowVersion.createdAt),
  auditTable(workflowEvent, workflowEvent.id, workflowEvent.at),
  auditTable(stepCatalogueVersion, stepCatalogueVersion.id, stepCatalogueVersion.createdAt),
  auditTable(stepCatalogueEvent, stepCatalogueEvent.id, stepCatalogueEvent.at),
  auditTable(boardMessage, boardMessage.id, boardMessage.createdAt),
  auditTable(boardMessageTag, boardMessageTag.id, null),
  auditTable(doc, doc.id, doc.createdAt),
  auditTable(docRevision, docRevision.id, docRevision.at),
] as const

function auditableColumn(column: AnyPgColumn): boolean {
  const sqlType = column.getSQLType().toLowerCase()
  return sqlType === 'text' || sqlType.startsWith('varchar') || sqlType === 'jsonb'
}

/** Every textual schema column except structured fields in the shared exclusion declaration. */
export const HOSTED_SECRET_AUDIT_SCHEMA: readonly HostedSecretAuditSchemaEntry[] =
  HOSTED_SECRET_AUDIT_TABLES.map((entry) => {
    const table = getTableName(entry.table)
    return {
      ...entry,
      columns: Object.values(getTableColumns(entry.table)).filter(
        (column): column is AnyPgColumn =>
          auditableColumn(column as AnyPgColumn) &&
          !isHostedAuditColumnExcluded(table, (column as AnyPgColumn).name),
      ),
    }
  })

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
    const { id, createdAt } = cell
    if (cell.value === null || id === undefined || createdAt === undefined) return []
    return redactSecretShaped(cell.value, { exemptEvidenceTokens: true }).rules.flatMap((rule) => {
      if (options.rule !== undefined && rule !== options.rule) return []
      const precision = secretShapedRulePrecision(rule)
      return precision
        ? [
            {
              table: cell.table,
              column: cell.column,
              id,
              createdAt,
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
  for (const declaration of HOSTED_SECRET_AUDIT_SCHEMA) {
    const table = getTableName(declaration.table)
    for (const column of declaration.columns) {
      const timestamp = declaration.timestamp ? `${declaration.timestamp.name}::text` : 'NULL::text'
      const rows = await postgres.unsafe(
        `SELECT ${declaration.id.name}::text AS id, ${timestamp} AS created_at, ${column.name}::text AS value FROM ${table} WHERE ${column.name} IS NOT NULL`,
      )
      for (const row of rows as Array<Record<string, unknown>>) {
        cells.push(hostedAuditCell(table, column.name, row))
      }
    }
  }
  return cells
}

function hostedAuditCell(
  table: string,
  column: string,
  row: Record<string, unknown>,
): HostedSecretAuditCell {
  return {
    table,
    column,
    id: String(row.id),
    createdAt: typeof row.created_at === 'string' ? row.created_at : '-',
    value: typeof row.value === 'string' ? row.value : null,
  }
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
