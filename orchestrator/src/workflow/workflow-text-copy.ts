// concern: workflows
/** Copies cursor text to task documents and reads live or preserved attachments. */

import type { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { db, nowIso, writeTransaction } from '../database/db.ts'
import type { LiveCursorAutonomy } from './autonomy.ts'
import { abandonSelectedWorkflowCursorForClose, nextWorkflowStep } from './workflow-cursor.ts'
import { cursorName } from './workflow-cursor-format.ts'
import {
  refuseMissingAbandonReason,
  refuseMissingCloseNote,
  refuseTerminalCursor,
} from './workflow-cursor-result.ts'
import type { WorkflowCloseCursor } from './workflow-cursor-row.ts'
import type { WorkflowCursorContext } from './workflow-cursor-selection.ts'
import { selectWorkflowCursorForClose } from './workflow-cursor-selection.ts'
import type { FloorEvidencePorts, WorkflowEvidenceInput } from './workflow-floor-evidence.ts'
import type { WorkflowSelfRulingInput } from './workflow-self-ruling-mutation.ts'
import { type HubTaskReader, readHubTasks, taskCommand } from './workflow-task-reference.ts'
import {
  deleteWorkflowText,
  workflowTextAttachmentId,
  workflowTextAttachmentToken,
} from './workflow-text.ts'

export type WorkflowTaskDocument = { reference: string; title: string }
export type WorkflowTextDocumentPorts = {
  list(taskKey: string, project: string): Promise<WorkflowTaskDocument[]>
  create(taskKey: string, project: string, title: string, body: string): Promise<string>
}

type CopyRow = { id: string; stepSlug: string; body: string }
type CopyCursor = {
  recordId: string
  number: number
  project: string
  taskRecordId: string | null
  state: string
}
export type WorkflowTextCopyResult = {
  cursor: number
  copied: { id: string; documentReference: string; reused: boolean }[]
  uncopied: { id: string; reason: string }[]
}

export const productionWorkflowTextDocumentPorts: WorkflowTextDocumentPorts = {
  async list(taskKey, project) {
    const rows = JSON.parse(
      await taskCommand(['task', 'doc', 'list', taskKey, '--project', project, '--json']),
    ) as { label?: unknown; id?: unknown; title?: unknown }[]
    if (!Array.isArray(rows)) throw new Error('task document list response was not an array')
    return rows.map((row) => {
      const reference = typeof row.label === 'string' ? row.label : row.id
      if (typeof reference !== 'string' || typeof row.title !== 'string')
        throw new Error('task document list response contained an invalid document')
      return { reference, title: row.title }
    })
  },
  async create(taskKey, project, title, body) {
    const directory = mkdtempSync(join(tmpdir(), 'workflow-text-copy-'))
    const bodyPath = join(directory, 'body.md')
    try {
      writeFileSync(bodyPath, body)
      return await taskCommand([
        'task',
        'doc',
        'new',
        taskKey,
        '--project',
        project,
        '--title',
        title,
        '--body-file',
        bodyPath,
      ])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  },
}

const firstToken = (title: string) => title.trim().split(/\s+/, 1)[0] ?? ''

function uncopiedRows(cursorId: string, database: Database): CopyRow[] {
  return database
    .query<{ record_id: string; step_slug: string; body: string }, [string]>(
      `SELECT t.record_id,t.step_slug,t.body FROM workflow_step_text t
       LEFT JOIN workflow_text_copy c ON c.workflow_text_record_id=t.record_id
       WHERE t.cursor_record_id=? AND c.workflow_text_record_id IS NULL
       ORDER BY t.step_ordinal,t.rowid`,
    )
    .all(cursorId)
    .map((row) => ({ id: row.record_id, stepSlug: row.step_slug, body: row.body }))
}

function recordCopy(cursorId: string, textId: string, reference: string, database: Database): void {
  writeTransaction(() => {
    database
      .query(
        `INSERT OR IGNORE INTO workflow_text_copy
         (record_id,workflow_text_record_id,cursor_record_id,task_document_reference,copied_at)
         VALUES (?,?,?,?,?)`,
      )
      .run(newRecordId(), textId, cursorId, reference, nowIso())
  }, database)
}

export async function copyWorkflowTextForCursor(
  cursor: CopyCursor,
  database: Database = db(),
  taskReader: HubTaskReader = readHubTasks,
  documents: WorkflowTextDocumentPorts = productionWorkflowTextDocumentPorts,
): Promise<WorkflowTextCopyResult> {
  const rows = uncopiedRows(cursor.recordId, database)
  if (!cursor.taskRecordId || rows.length === 0)
    return { cursor: cursor.number, copied: [], uncopied: [] }
  try {
    const task = (await taskReader(cursor.project)).find(
      (candidate) => candidate.record_id === cursor.taskRecordId,
    )
    if (!task)
      throw new Error(
        `task record ${cursor.taskRecordId} is not readable in project ${cursor.project}`,
      )
    const existing = await documents.list(task.key, cursor.project)
    const copied: WorkflowTextCopyResult['copied'] = []
    const uncopied: WorkflowTextCopyResult['uncopied'] = []
    for (const row of rows) {
      try {
        const token = workflowTextAttachmentToken(row.id)
        const found = existing.find((document) => firstToken(document.title) === token)
        const reference =
          found?.reference ??
          (await documents.create(task.key, cursor.project, `${token} ${row.stepSlug}`, row.body))
        recordCopy(cursor.recordId, row.id, reference, database)
        copied.push({ id: row.id, documentReference: reference, reused: Boolean(found) })
        if (!found) existing.push({ reference, title: `${token} ${row.stepSlug}` })
      } catch (error) {
        uncopied.push({
          id: row.id,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }
    if (cursor.state === 'done' || cursor.state === 'abandoned')
      writeTransaction(() => deleteWorkflowText(cursor.recordId, true, database), database)
    return { cursor: cursor.number, copied, uncopied }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      cursor: cursor.number,
      copied: [],
      uncopied: rows.map((row) => ({ id: row.id, reason })),
    }
  }
}

type CloseTarget = {
  project?: string
  workflow?: string
  mode?: string
  key?: string
  cursor?: number
  args: Record<string, string>
  context: WorkflowCursorContext
}

export type WorkflowTextCloseInput =
  | (CloseTarget & {
      action: 'next'
      note?: string
      evidence?: WorkflowEvidenceInput
      floorPorts?: FloorEvidencePorts
      selfRuling?: WorkflowSelfRulingInput
      outcome?: string
      live?: LiveCursorAutonomy
    })
  | (CloseTarget & { action: 'abandon'; reason?: string })

/** Owns validation, preservation, transactional close, and the uncopied remedy. */
export async function closeCursorWithTextCopy(
  input: WorkflowTextCloseInput,
  database: Database = db(),
  taskReader: HubTaskReader = readHubTasks,
  documents: WorkflowTextDocumentPorts = productionWorkflowTextDocumentPorts,
): Promise<string> {
  const row = selectWorkflowCursorForClose(
    {
      project: input.project,
      workflow: input.workflow,
      mode: input.mode,
      key: input.key,
    },
    input.cursor,
    input.context.session,
    database,
    input.context.taskRecordId,
  ) as WorkflowCloseCursor | null
  if (!row)
    throw new Error(
      `${cursorName(input.workflow ?? 'workflow', input.mode ?? 'default', input.key ?? '')} has no cursor; compose the workflow first`,
    )
  refuseTerminalCursor(row)
  if (input.action === 'next') refuseMissingCloseNote(input.note, row.ordinal + 1, row.step_slug)
  else refuseMissingAbandonReason(input.reason)

  const copy = await copyWorkflowTextForCursor(
    {
      recordId: row.record_id,
      number: row.id,
      project: row.project,
      taskRecordId:
        row.task_record_id ??
        input.context.adoptionTaskRecordId ??
        input.context.taskRecordId ??
        null,
      state: row.state,
    },
    database,
    taskReader,
    documents,
  )
  const result =
    input.action === 'next'
      ? nextWorkflowStep(
          row.workflow_slug,
          row.project,
          row.mode_slug,
          input.args,
          input.note!.trim(),
          input.context,
          database,
          input.evidence,
          input.floorPorts,
          row.id,
          input.selfRuling,
          input.outcome,
          input.live,
          row,
        )
      : abandonSelectedWorkflowCursorForClose(
          row,
          input.reason!.trim(),
          input.context,
          database,
          input.args,
        )
  const warning = workflowTextUncopiedReport(copy)
  return warning ? `${result}\n${warning}` : result
}

function uncopiedLine(row: WorkflowTextCopyResult['uncopied'][number], cursor: number): string {
  return `${workflowTextAttachmentToken(row.id)} is still uncopied: ${row.reason}; retry: ${PLATFORM_SLUG} workflow text copy --cursor ${cursor}`
}

export function workflowTextCopyReport(
  result: WorkflowTextCopyResult,
  cursor = result.cursor,
): string {
  const lines = result.copied.map(
    (row) =>
      `${workflowTextAttachmentToken(row.id)} ${row.reused ? 'reuses' : 'copied to'} ${row.documentReference}`,
  )
  for (const row of result.uncopied) lines.push(uncopiedLine(row, cursor))
  return lines.join('\n')
}

export function workflowTextUncopiedReport(
  result: WorkflowTextCopyResult,
  cursor = result.cursor,
): string {
  return result.uncopied.map((row) => uncopiedLine(row, cursor)).join('\n')
}

export function showWorkflowText(
  idInput: string,
  database: Database = db(),
):
  | { kind: 'live'; id: string; cursor: number; stepSlug: string; body: string }
  | { kind: 'redirect'; id: string; documentReference: string } {
  const id = workflowTextAttachmentId(idInput)
  const live = database
    .query<{ cursor: number; step_slug: string; body: string }, [string]>(
      `SELECT c.number cursor,t.step_slug,t.body FROM workflow_step_text t
       JOIN workflow_cursor c ON c.record_id=t.cursor_record_id WHERE t.record_id=?`,
    )
    .get(id)
  if (live)
    return { kind: 'live', id, cursor: live.cursor, stepSlug: live.step_slug, body: live.body }
  const copied = database
    .query<{ task_document_reference: string }, [string]>(
      'SELECT task_document_reference FROM workflow_text_copy WHERE workflow_text_record_id=?',
    )
    .get(id)
  if (copied) return { kind: 'redirect', id, documentReference: copied.task_document_reference }
  throw new Error(
    `${workflowTextAttachmentToken(id)} is not held on this machine; attachments of a cursor not linked to a task are removed when the cursor closes, and an id from another machine is readable only through its task document`,
  )
}

export function cursorForWorkflowTextCopy(cursor: number, database: Database = db()): CopyCursor {
  const row = selectWorkflowCursorForClose({}, cursor, null, database) as WorkflowCloseCursor
  return {
    recordId: row.record_id,
    number: row.id,
    project: row.project,
    taskRecordId: row.task_record_id,
    state: row.state,
  }
}
