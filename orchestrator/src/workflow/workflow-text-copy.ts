// concern: workflows
/** Copies cursor text to task documents and reads live or preserved attachments. */

import type { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db, writeTransaction } from '../database/db.ts'
import type { RecordTaskFlowClient } from '../record/record-api-client-task-flow.ts'
import {
  type TaskFlowWriteTarget,
  taskFlowWriteTarget,
  writeHostedTaskFlow,
} from '../record/record-task-flow-write-client.ts'
import { taskFlowRequestId } from '../record/record-task-flow-write-contract.ts'
import type { LiveCursorAutonomy } from './autonomy.ts'
import { taskFlowLocalStore, taskFlowReadStore } from './task-flow-store.ts'
import { abandonSelectedWorkflowCursorForClose, nextWorkflowStep } from './workflow-cursor.ts'
import { cursorName } from './workflow-cursor-format.ts'
import {
  refuseMissingAbandonReason,
  refuseMissingCloseNote,
  refuseTerminalCursor,
} from './workflow-cursor-result.ts'
import {
  readThroughWorkflowCursorContext,
  type SelectableCursorRow,
  selectWorkflowCursorForClose,
  type WorkflowCursorContext,
} from './workflow-cursor-selection.ts'
import type { FloorEvidencePorts, WorkflowEvidenceInput } from './workflow-floor-evidence.ts'
import {
  assertWorkflowSelfRulingProse,
  type WorkflowSelfRulingInput,
} from './workflow-self-ruling-mutation.ts'
import {
  type HubTaskReader,
  type HubTaskReference,
  readHubTasks,
  taskCommand,
  taskKeyMap,
  taskReadRefusal,
  taskReferenceForProjectKey,
} from './workflow-task-reference.ts'
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

type CopyRow = { id: string; stepSlug: string; body: string; createdAt: string }
type CopyCursor = {
  recordId: string
  number: number
  project: string
  taskKey?: string | null
  taskRecordId: string | null
  state: string
}
export type WorkflowTextCopyResult = {
  cursor: number
  copied: { id: string; documentReference: string; reused: boolean }[]
  uncopied: { id: string; reason: string }[]
  unsupported: { reason: string } | null
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

async function uncopiedRows(cursorId: string, database: Database): Promise<CopyRow[]> {
  return (await taskFlowReadStore(database).uncopiedTextsForStage(cursorId)).map((row) => ({
    id: row.record_id,
    stepSlug: row.step_slug,
    body: row.body,
    createdAt: row.created_at,
  }))
}

async function recordCopy(
  cursorId: string,
  textId: string,
  reference: string,
  database: Database,
  copiedAt: string,
  target: TaskFlowWriteTarget,
  client?: RecordTaskFlowClient,
): Promise<void> {
  const id = taskFlowRequestId('copy-text', [cursorId, textId, reference])
  const payload = {
    requestId: taskFlowRequestId('copy-text', [id]),
    row: {
      id,
      workflowTextRecordId: textId,
      stageRecordId: cursorId,
      taskDocumentReference: reference,
      copiedAt,
    },
  }
  const hosted = await writeHostedTaskFlow('copy-text', payload, target, client)
  writeTransaction(() => {
    taskFlowLocalStore(database).write('copy-text', payload, hosted)
  }, database)
}

function unsupportedCopyResult(
  task: HubTaskReference,
  rows: CopyRow[],
  cursor: number,
): WorkflowTextCopyResult | null {
  if (!task.source || task.source === 'local') return null
  const references = rows.map((row) => workflowTextAttachmentToken(row.id)).join(', ')
  return {
    cursor,
    copied: [],
    uncopied: [],
    unsupported: {
      reason:
        `task ${task.key} is kept in its project's own tracker; ` +
        `workflow text copy does not support it, and each text stays readable with ${PLATFORM_SLUG} workflow text show <reference>: ${references}`,
    },
  }
}

export async function copyWorkflowTextForCursor(
  cursor: CopyCursor,
  database: Database = db(),
  taskReader: HubTaskReader = readHubTasks,
  documents: WorkflowTextDocumentPorts = productionWorkflowTextDocumentPorts,
  client?: RecordTaskFlowClient,
): Promise<WorkflowTextCopyResult> {
  const rows = await uncopiedRows(cursor.recordId, database)
  if (!cursor.taskRecordId || rows.length === 0)
    return { cursor: cursor.number, copied: [], uncopied: [], unsupported: null }
  const target = taskFlowWriteTarget(cursor.project, database)
  try {
    const task = (await taskReader(cursor.project)).find(
      (candidate) => candidate.record_id === cursor.taskRecordId,
    )
    if (!task)
      throw new Error(
        `task record ${cursor.taskRecordId} is not readable in project ${cursor.project}`,
      )
    const unsupported = unsupportedCopyResult(task, rows, cursor.number)
    if (unsupported) return unsupported
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
        await recordCopy(
          cursor.recordId,
          row.id,
          reference,
          database,
          row.createdAt,
          target,
          client,
        )
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
      await deleteWorkflowText(cursor.recordId, true, database, client)
    return { cursor: cursor.number, copied, uncopied, unsupported: null }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      cursor: cursor.number,
      copied: [],
      uncopied: rows.map((row) => ({ id: row.id, reason })),
      unsupported: null,
    }
  }
}

/** Resolves an explicit task only for a keyless cursor, then uses the ordinary copy path. */
export async function copyWorkflowTextForTask(
  cursor: CopyCursor,
  taskKey: string | undefined,
  database: Database = db(),
  taskReader: HubTaskReader = readHubTasks,
  documents: WorkflowTextDocumentPorts = productionWorkflowTextDocumentPorts,
): Promise<WorkflowTextCopyResult> {
  if (!taskKey) return copyWorkflowTextForCursor(cursor, database, taskReader, documents)
  if (cursor.taskRecordId) {
    const ownTask = cursor.taskKey ?? cursor.taskRecordId
    throw new Error(
      `cursor ${cursor.number} belongs to task ${ownTask}; --task is only for a keyless cursor, so omit --task to copy to ${ownTask}`,
    )
  }
  let tasks: HubTaskReference[]
  try {
    tasks = await taskReader(cursor.project)
  } catch (error) {
    throw taskReadRefusal(cursor.project, error instanceof Error ? error.message : String(error))
  }
  const task = taskReferenceForProjectKey(taskKeyMap(tasks), cursor.project, taskKey)
  if (!task) {
    throw new Error(
      `task ${taskKey} does not exist in project ${cursor.project}; ` +
        `find it with ${PLATFORM_SLUG} task list --project ${cursor.project} --json ` +
        `or create it with ${PLATFORM_SLUG} task new --project ${cursor.project}`,
    )
  }
  return copyWorkflowTextForCursor(
    { ...cursor, taskKey: task.key, taskRecordId: task.record_id },
    database,
    async () => tasks,
    documents,
  )
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
  return (await closeCursorWithTextCopyResult(input, database, taskReader, documents)).text
}

export type WorkflowTextCloseResult = {
  text: string
  selfRulingQuestionNumber?: number
  cursorNumber: number
  cursorRecordId: string
  workflowKey: string | null
  finished: boolean
  stepSlug?: string
  stepTitle?: string
}

/** Closes a cursor while retaining the question identity created by a self-ruling. */
export async function closeCursorWithTextCopyResult(
  input: WorkflowTextCloseInput,
  database: Database = db(),
  taskReader: HubTaskReader = readHubTasks,
  documents: WorkflowTextDocumentPorts = productionWorkflowTextDocumentPorts,
): Promise<WorkflowTextCloseResult> {
  if (input.action === 'next') await assertWorkflowSelfRulingProse(input.selfRuling)
  const row = (await selectWorkflowCursorForClose(
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
    input.context.taskStatusCategory,
  )) as SelectableCursorRow | null
  if (!row)
    throw new Error(
      `${cursorName(input.workflow ?? 'workflow', input.mode ?? 'default', input.key ?? '')} has no cursor; compose the workflow first`,
    )
  refuseTerminalCursor(row)
  if (input.action === 'next') refuseMissingCloseNote(input.note, row.ordinal + 1, row.step_slug)
  else refuseMissingAbandonReason(input.reason)
  await readThroughWorkflowCursorContext(row.project, input.context, database)

  const copy = await copyWorkflowTextForCursor(
    {
      recordId: row.record_id,
      number: row.id,
      project: row.project,
      taskKey: row.workflow_key || null,
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
    input.context.taskFlowClient,
  )
  const result: WorkflowTextCloseResult =
    input.action === 'next'
      ? await nextWorkflowStep(
          row,
          row.project,
          input.args,
          input.note!.trim(),
          input.context,
          database,
          input.evidence,
          input.floorPorts,
          input.selfRuling,
          input.outcome,
          input.live,
        )
      : {
          text: await abandonSelectedWorkflowCursorForClose(
            row,
            input.reason!.trim(),
            input.context,
            database,
            input.args,
          ),
          cursorNumber: row.id,
          cursorRecordId: row.record_id,
          workflowKey: row.workflow_key || null,
          finished: row.state === 'done',
          stepSlug: row.step_slug,
          stepTitle: undefined,
        }
  const warning = workflowTextUncopiedReport(copy)
  return { ...result, text: warning ? `${result.text}\n${warning}` : result.text }
}

function uncopiedLine(row: WorkflowTextCopyResult['uncopied'][number], cursor: number): string {
  return `${workflowTextAttachmentToken(row.id)} is still uncopied: ${row.reason}; retry: ${PLATFORM_SLUG} workflow text copy --cursor ${cursor}`
}

export function workflowTextCopyReport(
  result: WorkflowTextCopyResult,
  cursor = result.cursor,
): string {
  if (result.unsupported) return result.unsupported.reason
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
  if (result.unsupported) return result.unsupported.reason
  return result.uncopied.map((row) => uncopiedLine(row, cursor)).join('\n')
}

export async function showWorkflowText(
  idInput: string,
  database: Database = db(),
): Promise<
  | { kind: 'live'; id: string; cursor: number; stepSlug: string; body: string }
  | { kind: 'redirect'; id: string; documentReference: string }
> {
  const id = workflowTextAttachmentId(idInput)
  const store = taskFlowReadStore(database)
  const live = await store.liveTextAttachment(id)
  if (live)
    return { kind: 'live', id, cursor: live.cursor, stepSlug: live.step_slug, body: live.body }
  const copied = await store.copiedTextReference(id)
  if (copied) return { kind: 'redirect', id, documentReference: copied }
  throw new Error(
    `${workflowTextAttachmentToken(id)} is not held on this machine; attachments of a cursor not linked to a task are removed when the cursor closes, and an id from another machine is readable only through its task document`,
  )
}

export async function cursorForWorkflowTextCopy(
  cursor: number,
  database: Database = db(),
): Promise<CopyCursor> {
  const row = (await selectWorkflowCursorForClose(
    {},
    cursor,
    null,
    database,
  )) as SelectableCursorRow
  return {
    recordId: row.record_id,
    number: row.id,
    project: row.project,
    taskKey: row.workflow_key || null,
    taskRecordId: row.task_record_id,
    state: row.state,
  }
}
