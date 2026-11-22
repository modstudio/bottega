// concern: hosted-secret-audit
/** Reads declared hosted free-text columns and counts secret-shaped values without retaining evidence. */
import type { SQL } from 'bun'
import { getTableName, type Table } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { contextItem } from '../../../shared/record/schema-context-items.ts'
import { doc, docRevision } from '../../../shared/record/schema-docs.ts'
import { hubNote, hubTask, hubTaskComment, hubTaskDocument } from '../../../shared/record/schema-hub.ts'
import { question } from '../../../shared/record/schema-question.ts'
import { workflowStepText } from '../../../shared/record/schema-task-flow.ts'
import { workflowVersion } from '../../../shared/record/schema-workflow-catalogue.ts'
import { boardMessage, boardMessageTag } from '../../../shared/record/schema-board.ts'
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

type HostedSecretAuditSchemaEntry = {
  table: Table
  id: AnyPgColumn
  timestamp: AnyPgColumn | null
  columns: readonly AnyPgColumn[]
}

/** Schema-bound declaration for every hosted table and free-text column scanned by the audit. */
export const HOSTED_SECRET_AUDIT_SCHEMA: readonly HostedSecretAuditSchemaEntry[] = [
  {
    table: hubNote,
    id: hubNote.id,
    timestamp: hubNote.createdAt,
    columns: [hubNote.text, hubNote.area, hubNote.staleReason, hubNote.anchors],
  },
  {
    table: hubTask,
    id: hubTask.id,
    timestamp: hubTask.createdAt,
    columns: [hubTask.title, hubTask.body],
  },
  {
    table: hubTaskComment,
    id: hubTaskComment.id,
    timestamp: hubTaskComment.createdAt,
    columns: [hubTaskComment.body],
  },
  {
    table: hubTaskDocument,
    id: hubTaskDocument.id,
    timestamp: hubTaskDocument.createdAt,
    columns: [hubTaskDocument.title, hubTaskDocument.body],
  },
  {
    table: contextItem,
    id: contextItem.id,
    timestamp: contextItem.createdAt,
    columns: [contextItem.body, contextItem.source, contextItem.target],
  },
  {
    table: question,
    id: question.id,
    timestamp: question.createdAt,
    columns: [
      question.question,
      question.answer,
      question.answerBasis,
      question.replacement,
      question.overturnReason,
    ],
  },
  {
    table: workflowStepText,
    id: workflowStepText.id,
    timestamp: workflowStepText.createdAt,
    columns: [workflowStepText.body],
  },
  {
    table: workflowVersion,
    id: workflowVersion.id,
    timestamp: workflowVersion.createdAt,
    columns: [workflowVersion.definition, workflowVersion.author, workflowVersion.reason],
  },
  {
    table: boardMessage,
    id: boardMessage.id,
    timestamp: boardMessage.createdAt,
    columns: [boardMessage.body],
  },
  {
    table: boardMessageTag,
    id: boardMessageTag.id,
    timestamp: null,
    columns: [boardMessageTag.value],
  },
  {
    table: doc,
    id: doc.id,
    timestamp: doc.createdAt,
    columns: [doc.title, doc.body],
  },
  {
    table: docRevision,
    id: docRevision.id,
    timestamp: docRevision.at,
    columns: [docRevision.title, docRevision.body],
  },
]

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
        cells.push({
          table,
          column: column.name,
          id: String(row.id),
          createdAt: typeof row.created_at === 'string' ? row.created_at : '-',
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
