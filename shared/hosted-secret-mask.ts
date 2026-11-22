// concern: hosted-secret-mask
/** Schema-derived high-precision masking for hosted table writes and audits. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { getTableColumns, getTableName, type Table } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { PLATFORM_SLUG } from './brand.ts'
import { boardMessage, boardMessageTag } from './record/schema-board.ts'
import { contextItem } from './record/schema-context-items.ts'
import { doc, docRevision } from './record/schema-docs.ts'
import { hubNote, hubTask, hubTaskComment, hubTaskDocument } from './record/schema-hub.ts'
import { question } from './record/schema-question.ts'
import { workflowStepText, workflowTextCopy } from './record/schema-task-flow.ts'
import {
  stepCatalogueEvent,
  stepCatalogueVersion,
  workflowEvent,
  workflowVersion,
} from './record/schema-workflow-catalogue.ts'
import { redactSecretShaped } from './secret-shaped.ts'

type Exclusion = { path: string; reason: string }
const fields = (reason: string, ...paths: string[]): Exclusion[] =>
  paths.map((path) => ({ path, reason }))

/** The single exclusion declaration used by write masking and the hosted audit. */
export const HOSTED_SECRET_EXCLUSIONS = {
  defaults: [
    { suffix: 'id', reason: 'identifier' },
    { suffix: 'key', reason: 'identifier or lookup key' },
    { suffix: 'hash', reason: 'integrity hash' },
    { suffix: 'sha', reason: 'integrity hash' },
    { suffix: 'digest', reason: 'integrity digest' },
    { suffix: 'revision', reason: 'optimistic-concurrency revision' },
    { suffix: 'tokens', reason: 'token count' },
    { suffix: 'tokenCount', reason: 'token count' },
  ],
  tables: {
    hub_note: fields(
      'project identity or structured note state',
      'project_name',
      'project',
      'promoted_task',
      'hidden_reason',
    ),
    hub_task: fields(
      'project identity, task state, or source enum',
      'project_name',
      'key',
      'project',
      'status',
      'status_category',
      'parent_key',
      'source',
    ),
    hub_task_comment: fields(
      'task or actor identity',
      'project_name',
      'task_key',
      'actor_user_id',
      'run_id',
    ),
    hub_task_document: fields(
      'task identity or document version',
      'project_name',
      'task_key',
      'role',
      'version',
    ),
    context_item: fields(
      'holder identity, slug, or kind enum',
      'holder_kind',
      'holder_id',
      'slug',
      'kind',
    ),
    question: fields(
      'workflow identity or question state enum',
      'workflow_key',
      'workflow_step_slug',
      'asked_via',
      'kind',
      'answered_by_kind',
      'answerer_kind',
      'answer_channel',
      'filed_as',
      'filed_ref',
      'jev_model',
    ),
    workflow_step_text: fields('workflow step identity', 'step_slug'),
    workflow_text_copy: fields('task document identity', 'task_document_reference'),
    workflow_version: fields('workflow state enum', 'status'),
    workflow_event: fields('workflow event enum', 'event'),
    step_catalogue_version: fields('catalogue state enum', 'status'),
    step_catalogue_event: fields('catalogue event enum', 'event'),
    board_message: fields(
      'board identity, state, or audience enum; board text is refused before this boundary',
      'author_session',
      'author_harness',
      'kind',
      'purpose',
      'audience',
      'hidden_reason',
    ),
    board_message_tag: fields('board tag enum or origin identity', 'kind', 'origin'),
    doc: fields(
      'document address, lifecycle enum, or integrity metadata',
      'scope',
      'subject',
      'slug',
      'delivery',
      'audiences',
      'status',
      'kind',
      'form',
      'source_files',
      'checked_against_commit',
      'replacement_slug',
    ),
    doc_revision: fields(
      'document address, lifecycle enum, or integrity metadata',
      'scope',
      'subject',
      'slug',
      'op',
      'delivery',
      'audiences',
      'status',
      'kind',
      'form',
      'related_subject_ids',
      'source_files',
      'checked_against_commit',
      'replacement_slug',
    ),
  },
} as const

type HostedTableDefinition = { table: Table; timestamp: AnyPgColumn | null; mask: boolean }

/** The single hosted-table inventory used by both write masking and the audit. */
export const HOSTED_SECRET_TABLES = [
  { table: hubNote, timestamp: hubNote.createdAt, mask: true },
  { table: hubTask, timestamp: hubTask.createdAt, mask: true },
  { table: hubTaskComment, timestamp: hubTaskComment.createdAt, mask: true },
  { table: hubTaskDocument, timestamp: hubTaskDocument.createdAt, mask: true },
  { table: contextItem, timestamp: contextItem.createdAt, mask: true },
  { table: question, timestamp: question.createdAt, mask: true },
  { table: workflowStepText, timestamp: workflowStepText.createdAt, mask: true },
  { table: workflowTextCopy, timestamp: null, mask: true },
  { table: workflowVersion, timestamp: workflowVersion.createdAt, mask: true },
  { table: workflowEvent, timestamp: workflowEvent.at, mask: true },
  { table: stepCatalogueVersion, timestamp: stepCatalogueVersion.createdAt, mask: true },
  { table: stepCatalogueEvent, timestamp: stepCatalogueEvent.at, mask: true },
  { table: boardMessage, timestamp: boardMessage.createdAt, mask: false },
  { table: boardMessageTag, timestamp: null, mask: false },
  { table: doc, timestamp: doc.createdAt, mask: true },
  { table: docRevision, timestamp: docRevision.at, mask: true },
] as const satisfies readonly HostedTableDefinition[]

type HostedMaskWarning = { path: string; rule: string }
const warnings = new AsyncLocalStorage<HostedMaskWarning[]>()

function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

function defaultExcluded(name: string): boolean {
  const parts = words(name)
  return HOSTED_SECRET_EXCLUSIONS.defaults.some(({ suffix }) => {
    const wanted = words(suffix)
    return (
      wanted.length <= parts.length &&
      wanted.every((part, index) => part === parts[parts.length - wanted.length + index])
    )
  })
}

function explicitlyExcluded(table: string, name: string): boolean {
  const entries =
    HOSTED_SECRET_EXCLUSIONS.tables[table as keyof typeof HOSTED_SECRET_EXCLUSIONS.tables]
  return Boolean(entries?.some(({ path }) => path === name))
}

function isHostedAuditColumnExcluded(table: string, name: string): boolean {
  return defaultExcluded(name) || explicitlyExcluded(table, name)
}

function isHostedSecretColumn(column: AnyPgColumn): boolean {
  const sqlType = column.getSQLType().toLowerCase()
  return sqlType === 'text' || sqlType.startsWith('varchar') || sqlType === 'jsonb'
}

export function hostedSecretColumns(definition: HostedTableDefinition): AnyPgColumn[] {
  const table = getTableName(definition.table)
  return Object.values(getTableColumns(definition.table)).filter(
    (column): column is AnyPgColumn =>
      isHostedSecretColumn(column as AnyPgColumn) &&
      !isHostedAuditColumnExcluded(table, (column as AnyPgColumn).name),
  )
}

function maskColumnValue(value: unknown, path: string[]): unknown {
  if (typeof value === 'string') {
    const result = redactSecretShaped(value, { precision: 'high', exemptEvidenceTokens: true })
    for (const rule of result.rules) {
      const warning = { path: path.join('.'), rule }
      warnings.getStore()?.push(warning)
      console.warn(`${PLATFORM_SLUG}: masked ${warning.path} (${warning.rule})`)
    }
    return result.text
  }
  if (Array.isArray(value))
    return value.map((child, index) => maskColumnValue(child, [...path, String(index)]))
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([name, child]) => [
      name,
      defaultExcluded(name) ? child : maskColumnValue(child, [...path, name]),
    ]),
  )
}

/** Masks the schema-derived free-text columns of one hosted insert or update row. */
export function maskHostedTableWrite<T>(tableName: string, value: T): T {
  const definition = HOSTED_SECRET_TABLES.find((entry) => getTableName(entry.table) === tableName)
  if (!definition) throw new Error(`hosted table ${tableName} has no secret inventory entry`)
  if (!definition.mask) throw new Error(`hosted table ${tableName} uses refusal, not masking`)
  if (value === null || typeof value !== 'object') return value
  const clone = structuredClone(value) as Record<string, unknown>
  const columns = getTableColumns(definition.table)
  for (const [property, column] of Object.entries(columns)) {
    const typed = column as AnyPgColumn
    if (!isHostedSecretColumn(typed) || isHostedAuditColumnExcluded(tableName, typed.name)) continue
    const key = Object.hasOwn(clone, property)
      ? property
      : Object.hasOwn(clone, typed.name)
        ? typed.name
        : null
    if (key) clone[key] = maskColumnValue(clone[key], [tableName, typed.name])
  }
  return clone as T
}

/** Adds value-free masking warnings to HTTP responses; writers also log them for tRPC operators. */
export async function withHostedMaskWarnings(run: () => Promise<Response>): Promise<Response> {
  const observed: HostedMaskWarning[] = []
  const response = await warnings.run(observed, run)
  if (!observed.length) return response
  const headers = new Headers(response.headers)
  headers.set(
    'warning',
    observed.map(({ path, rule }) => `299 ${PLATFORM_SLUG} "masked ${path} (${rule})"`).join(', '),
  )
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
