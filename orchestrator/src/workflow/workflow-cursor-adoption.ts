// concern: workflow cursor task adoption
/** Atomically adopts a task key and republishes every cursor-bound question. */
import type { Database } from 'bun:sqlite'
import { nowIso } from '../database/db.ts'
import { enqueueQuestionRecord } from '../run/question-outbox.ts'
import { cursorAutonomy } from './workflow-cursor-autonomy.ts'
import { workflowTaskBindingCommand } from './workflow-cursor-format.ts'
import { getWorkflowStep } from './workflows.ts'

type AdoptionCursor = {
  id: number
  record_id: string
  project: string
  workflow_slug: string
  mode_slug: string
  workflow_key: string
  task_record_id: string | null
  args: string
}

type KeylessCloseCursor = AdoptionCursor & {
  ordinal: number
  step_slug: string
  workflow_version: number
  workflow_version_record_id: string
  catalogue_version: number
  catalogue_version_record_id: string
  autonomy: string | null
}

type LiveCursorAutonomy = NonNullable<Parameters<typeof cursorAutonomy>[1]>

function refuseKeylessStepClose(
  row: KeylessCloseCursor,
  suppliedTask: string | undefined,
  d: Database,
  live?: LiveCursorAutonomy,
): void {
  if (row.workflow_key || suppliedTask?.trim()) return
  const step = getWorkflowStep(
    row.workflow_slug,
    row.project,
    row.step_slug,
    JSON.parse(row.args),
    d,
    {
      mode: row.mode_slug,
      version: row.workflow_version,
      versionRecordId: row.workflow_version_record_id,
      catalogueVersion: row.catalogue_version,
      catalogueVersionRecordId: row.catalogue_version_record_id,
    },
    cursorAutonomy(row, live),
  )
  if (step.body.includes('<KEY>'))
    throw new Error(
      `step ${row.ordinal + 1} ${step.slug} used <KEY>; close it with: ${workflowTaskBindingCommand(row)}`,
    )
}

export function vacateRetiredWorkflowKeySlot(
  project: string,
  workflow: string,
  mode: string,
  key: string,
  d: Database,
): void {
  d.query(
    `UPDATE workflow_cursor SET instance_id=instance_id || '#' || number
     WHERE project_record_id=(SELECT record_id FROM project WHERE name=?)
       AND workflow_slug=? AND mode_slug=? AND workflow_key=? AND instance_id=''
       AND state IN ('done','abandoned')`,
  ).run(project, workflow, mode, key)
}

function assignWorkflowTaskKey(
  row: AdoptionCursor,
  key: string,
  taskRecordId: string | null,
  d: Database,
): void {
  vacateRetiredWorkflowKeySlot(row.project, row.workflow_slug, row.mode_slug, key, d)
  const adoptedArgs = { ...(JSON.parse(row.args) as Record<string, string>), key }
  d.query(
    "UPDATE workflow_cursor SET workflow_key=?,task_record_id=?,instance_id='',args=?,updated_at=? WHERE record_id=?",
  ).run(key, taskRecordId, JSON.stringify(adoptedArgs), nowIso(), row.record_id)
  row.workflow_key = key
  row.task_record_id = taskRecordId
  row.args = JSON.stringify(adoptedArgs)
  const questions = d
    .query<{ record_id: string }, [string]>(
      'SELECT record_id FROM question WHERE workflow_cursor_record_id=? ORDER BY number',
    )
    .all(row.record_id)
  for (const question of questions) {
    d.query(
      'UPDATE question SET workflow_key=?,workflow_task_record_id=?,revision=revision+1 WHERE record_id=?',
    ).run(key, taskRecordId, question.record_id)
    enqueueQuestionRecord(d, question.record_id)
  }
}

export function adoptWorkflowTask(
  row: KeylessCloseCursor,
  suppliedTask: string | undefined,
  taskRecordId: string | null | undefined,
  d: Database,
  live?: LiveCursorAutonomy,
): void {
  refuseKeylessStepClose(row, suppliedTask, d, live)
  const key = suppliedTask?.trim()
  if (!key) return
  if (row.workflow_key) {
    if (row.workflow_key !== key)
      throw new Error(
        `cursor ${row.id} is already assigned to ${row.workflow_key}; it cannot adopt ${key}`,
      )
    return
  }
  const conflict = d
    .query<{ id: number }, [string, string, string, string]>(
      `SELECT number id FROM workflow_cursor
       WHERE project_record_id=(SELECT record_id FROM project WHERE name=?)
         AND workflow_slug=? AND mode_slug=? AND workflow_key=?
         AND state NOT IN ('done','abandoned') LIMIT 1`,
    )
    .get(row.project, row.workflow_slug, row.mode_slug, key)
  if (conflict)
    throw new Error(
      `cursor ${row.id} cannot adopt ${key}; open cursor ${conflict.id} already holds it`,
    )
  assignWorkflowTaskKey(row, key, taskRecordId ?? null, d)
}
