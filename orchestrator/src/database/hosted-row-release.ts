// concern: hosted-row-release
/** Releases verified hosted workflow history while retaining incomplete tables and their parents. */
import type { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { resolveStateRoot } from '../../../shared/state-directory.ts'
import { BOUNDED_JSONL_ARCHIVE_KEEP, writeBoundedJsonlArchive } from '../jsonl-archive.ts'
import { readRecordInstallBinding } from '../record/install-binding.ts'
import { recordApiClient } from '../record/record-api-client.ts'
import {
  readHeldFlowIds,
  readHeldQuestionIds,
  WORKFLOW_HISTORY_UPLOAD_FINGERPRINT_KEY,
} from '../record/record-history-upload-state.ts'
import {
  collectHostedRowState,
  emptyHostedRowIds,
  HOSTED_ROW_TABLES,
  type HostedRowIds,
  type HostedRowPresence,
  type HostedRowReferences,
  type HostedRowTable,
  hostedRowIdsAreEmpty,
  type PresenceReader,
  questionAuditIdentity,
  readHostedRowPresence,
} from '../record/record-hosted-row-presence.ts'
import { withSynchronousDatabaseForMigrationStep, writeTransaction } from './db.ts'

const HOSTED_ROW_RELEASE_SHOWN_IDS = 5
export const HOSTED_ROW_RELEASE_ARCHIVE_KEEP = BOUNDED_JSONL_ARCHIVE_KEEP

export type HostedRowReleaseDecision = {
  deleteIds: HostedRowIds
  keptTables: Array<{ table: HostedRowTable; absentIds: readonly string[] }>
}

function addParents(
  kept: Record<HostedRowTable, Set<string>>,
  children: ReadonlySet<string>,
  parents: ReadonlyMap<string, string>,
  parentTable: HostedRowTable,
): boolean {
  let changed = false
  for (const child of children) {
    const parent = parents.get(child)
    if (parent && !kept[parentTable].has(parent)) {
      kept[parentTable].add(parent)
      changed = true
    }
  }
  return changed
}

/** Decide per-table retention and close retained parent references to a fixed point. */
export function decideHostedRowRelease(
  local: HostedRowIds,
  present: HostedRowPresence,
  references: HostedRowReferences,
  heldQuestionIds: ReadonlySet<string> = new Set(),
  heldFlowIds: ReadonlySet<string> = new Set(),
): HostedRowReleaseDecision {
  const kept = emptyHostedRowIds()
  const keptTables: HostedRowReleaseDecision['keptTables'] = []
  for (const flowId of heldFlowIds) {
    const cursorIds = new Set(
      [...local.workflow_cursor].filter((id) => references.cursorFlow.get(id) === flowId),
    )
    const flowChildren = {
      workflow_obligation: [...local.workflow_obligation].filter((id) =>
        cursorIds.has(references.obligationCursor.get(id) ?? ''),
      ),
      workflow_step_text: [...local.workflow_step_text].filter((id) =>
        cursorIds.has(references.stepTextCursor.get(id) ?? ''),
      ),
      workflow_text_copy: [...local.workflow_text_copy].filter((id) =>
        cursorIds.has(references.textCopyCursor.get(id) ?? ''),
      ),
    }
    const hasAbsentChild = Object.entries(flowChildren).some(([table, ids]) =>
      ids.some((id) => !present[table as keyof typeof flowChildren].has(id)),
    )
    if (!hasAbsentChild) continue
    kept.task_flow.add(flowId)
    for (const id of cursorIds) kept.workflow_cursor.add(id)
    for (const id of flowChildren.workflow_obligation) kept.workflow_obligation.add(id)
    for (const id of flowChildren.workflow_step_text) kept.workflow_step_text.add(id)
    for (const id of flowChildren.workflow_text_copy) kept.workflow_text_copy.add(id)
  }
  for (const table of HOSTED_ROW_TABLES) {
    const absent = [...local[table]].filter((id) => {
      if (present[table].has(id)) return false
      if (table === 'task_flow' && heldFlowIds.has(id)) return false
      if (table === 'workflow_cursor' && heldFlowIds.has(references.cursorFlow.get(id) ?? ''))
        return false
      if (table === 'question') return !heldQuestionIds.has(id)
      if (table !== 'question_mutation_audit') return true
      const questionId = references.auditQuestion.get(id)
      if (questionId && heldQuestionIds.has(questionId)) return false
      const identity = references.auditIdentity.get(id)
      return !identity || !present.questionAuditIdentities.has(questionAuditIdentity(identity))
    })
    if (!absent.length) continue
    for (const id of local[table]) kept[table].add(id)
    keptTables.push({ table, absentIds: absent })
  }
  let changed = true
  while (changed) {
    changed = false
    changed =
      addParents(kept, kept.workflow_obligation, references.obligationCursor, 'workflow_cursor') ||
      changed
    changed =
      addParents(kept, kept.workflow_step_text, references.stepTextCursor, 'workflow_cursor') ||
      changed
    changed =
      addParents(kept, kept.workflow_text_copy, references.textCopyCursor, 'workflow_cursor') ||
      changed
    changed =
      addParents(kept, kept.question_mutation_audit, references.auditQuestion, 'question') ||
      changed
    changed =
      addParents(kept, kept.question, references.questionCursor, 'workflow_cursor') || changed
    changed = addParents(kept, kept.workflow_cursor, references.cursorFlow, 'task_flow') || changed
    changed =
      addParents(kept, kept.workflow_cursor, references.cursorHandoff, 'workflow_cursor') || changed
    changed =
      addParents(kept, kept.task_flow, references.flowOpenCursor, 'workflow_cursor') || changed
  }
  const deleteIds = emptyHostedRowIds()
  for (const table of HOSTED_ROW_TABLES)
    for (const id of local[table]) if (!kept[table].has(id)) deleteIds[table].add(id)
  return {
    deleteIds,
    keptTables,
  }
}

function keptTableLine(table: HostedRowTable, ids: readonly string[]): string {
  const shown = ids.slice(0, HOSTED_ROW_RELEASE_SHOWN_IDS)
  const omitted = ids.length - shown.length
  return `kept local ${table}: ${ids.length} ids absent from the record: ${shown.join(', ')}${omitted ? `, and ${omitted} more` : ''}; run ${PLATFORM_SLUG} record sync, then ${PLATFORM_SLUG} machine update`
}

type Presentation = { log(value: string): void }
type WithDatabase = <T>(action: (database: Database) => T) => T
export type HostedRowReleaseDependencies = {
  withDatabase?: WithDatabase
  presence?: PresenceReader
  archive?: ArchiveWriter
}

function defaultPresenceReader(input: Parameters<PresenceReader>[0]) {
  const read = recordApiClient().readTaskFlowPresence
  if (!read)
    throw new Error('record API predates task-flow presence reads; release hosted-api, then retry')
  return read(input)
}

type ArchivedHostedRow = { table: HostedRowTable; row: Record<string, unknown> }
type ArchiveWriter = (rows: readonly ArchivedHostedRow[]) => string

export function writeHostedRowReleaseArchive(
  rows: readonly ArchivedHostedRow[],
  input: { directory?: string; now?: Date } = {},
): string {
  const directory =
    input.directory ?? join(resolveStateRoot(process.env), 'archive', 'hosted-row-release')
  return writeBoundedJsonlArchive(rows, {
    directory,
    keep: HOSTED_ROW_RELEASE_ARCHIVE_KEEP,
    now: input.now,
  })
}

function rowsToArchive(database: Database, ids: HostedRowIds): ArchivedHostedRow[] {
  const rows: ArchivedHostedRow[] = []
  const statements = {
    workflow_obligation: database.query<Record<string, unknown>, [string]>(
      'SELECT * FROM workflow_obligation WHERE record_id=?',
    ),
    workflow_step_text: database.query<Record<string, unknown>, [string]>(
      'SELECT * FROM workflow_step_text WHERE record_id=?',
    ),
    workflow_text_copy: database.query<Record<string, unknown>, [string]>(
      'SELECT * FROM workflow_text_copy WHERE record_id=?',
    ),
    question_mutation_audit: database.query<Record<string, unknown>, [string]>(
      'SELECT * FROM question_mutation_audit WHERE record_id=?',
    ),
    question: database.query<Record<string, unknown>, [string]>(
      'SELECT * FROM question WHERE record_id=?',
    ),
    workflow_cursor: database.query<Record<string, unknown>, [string]>(
      'SELECT * FROM workflow_cursor WHERE record_id=?',
    ),
    task_flow: database.query<Record<string, unknown>, [string]>(
      'SELECT * FROM task_flow WHERE record_id=?',
    ),
  }
  for (const table of HOSTED_ROW_TABLES) {
    for (const id of ids[table]) {
      const row = statements[table].get(id)
      if (row) rows.push({ table, row })
    }
  }
  return rows
}

function deleteHostedRows(database: Database, ids: HostedRowIds): void {
  writeTransaction(() => {
    const statements = {
      workflow_obligation: database.query('DELETE FROM workflow_obligation WHERE record_id=?'),
      workflow_step_text: database.query('DELETE FROM workflow_step_text WHERE record_id=?'),
      workflow_text_copy: database.query('DELETE FROM workflow_text_copy WHERE record_id=?'),
      question_mutation_audit: database.query(
        'DELETE FROM question_mutation_audit WHERE record_id=?',
      ),
      question: database.query('DELETE FROM question WHERE record_id=?'),
      workflow_cursor: database.query('DELETE FROM workflow_cursor WHERE record_id=?'),
      task_flow: database.query('DELETE FROM task_flow WHERE record_id=?'),
    }
    const clearHandoff = database.query(
      'UPDATE workflow_cursor SET handed_off_from_record_id=NULL WHERE record_id=?',
    )
    for (const id of ids.workflow_cursor) clearHandoff.run(id)
    // Children precede parents by foreign key.
    for (const table of HOSTED_ROW_TABLES) for (const id of ids[table]) statements[table].run(id)
    database
      .query('DELETE FROM schema_meta WHERE key=?')
      .run(WORKFLOW_HISTORY_UPLOAD_FINGERPRINT_KEY)
  }, database)
}

/** Release verified rows; incomplete tables are reported and retained without failing update. */
export async function releaseHostedRowsAfterUpdate(
  presentation: Presentation,
  deps: HostedRowReleaseDependencies = {},
): Promise<void> {
  const withDatabase = deps.withDatabase ?? withSynchronousDatabaseForMigrationStep
  const state = withDatabase((database) =>
    readRecordInstallBinding(database).bound ? collectHostedRowState(database) : null,
  )
  if (!state || hostedRowIdsAreEmpty(state.ids)) return
  let present: HostedRowPresence
  try {
    present = await readHostedRowPresence(state.ids, deps.presence ?? defaultPresenceReader)
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    presentation.log(`kept all local workflow history: record presence read failed: ${detail}`)
    return
  }
  const heldIds = withDatabase((database) => ({
    flows: readHeldFlowIds(database),
    questions: readHeldQuestionIds(database),
  }))
  const decision = decideHostedRowRelease(
    state.ids,
    present,
    state.references,
    heldIds.questions,
    heldIds.flows,
  )
  const released = HOSTED_ROW_TABLES.reduce(
    (total, table) => total + decision.deleteIds[table].size,
    0,
  )
  let archivePath: string | null = null
  if (released) {
    try {
      archivePath = withDatabase((database) =>
        (deps.archive ?? writeHostedRowReleaseArchive)(rowsToArchive(database, decision.deleteIds)),
      )
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      presentation.log(
        `kept all releasable local workflow history: archive write failed: ${detail}`,
      )
      return
    }
  }
  withDatabase((database) => deleteHostedRows(database, decision.deleteIds))
  if (archivePath) presentation.log(`archived released local workflow history at ${archivePath}`)
  for (const report of decision.keptTables)
    presentation.log(keptTableLine(report.table, report.absentIds))
  if (released)
    presentation.log(`released ${released} local workflow history rows now on the record`)
}
