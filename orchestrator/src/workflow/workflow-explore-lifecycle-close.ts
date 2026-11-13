// concern: workflow explore lifecycle close
/** Closes an idle explore from session lifecycle cleanup without impersonating an agent ruling. */

import type { Database } from 'bun:sqlite'
import { nowIso } from '../database/db.ts'
import { questionOpenSql } from '../run/question-open.ts'
import { taskFlowReadStore } from './task-flow-store.ts'
import { writeFinishingWorkflowAdvance } from './workflow-cursor.ts'
import type { CursorTrailEntry } from './workflow-cursor-trail.ts'
import { workflowTextDeletionIds } from './workflow-text.ts'

export type ExploreLifecycleOutcome = 'answered' | 'expired'

export async function closeExploreForLifecycle(
  cursorRecordId: string,
  outcome: ExploreLifecycleOutcome,
  database: Database,
): Promise<void> {
  const row = await taskFlowReadStore(database).stageByRecordId(cursorRecordId)
  if (!row || row.state === 'done' || row.state === 'abandoned') return
  if (row.workflow_slug !== 'explore' || row.workflow_key)
    throw new Error(`workflow cursor ${row.id} is not a keyless explore`)
  const openQuestion = database
    .query<{ record_id: string }, [string]>(
      `SELECT record_id FROM question WHERE workflow_cursor_record_id=?
       AND ${questionOpenSql('question')} LIMIT 1`,
    )
    .get(row.record_id)
  if (openQuestion)
    throw new Error(
      `workflow question ${openQuestion.record_id} is still open; answer or abandon it`,
    )

  const at = nowIso()
  const closed = JSON.parse(row.closed) as CursorTrailEntry[]
  closed.push({
    n: row.ordinal + 1,
    slug: row.step_slug,
    note: `session lifecycle closed explore as ${outcome}`,
    outcome,
    at,
  })
  const deleteTextIds =
    outcome === 'expired'
      ? []
      : await workflowTextDeletionIds(row.record_id, Boolean(row.task_record_id), database)
  await writeFinishingWorkflowAdvance({
    row,
    closed,
    deleteTextIds,
    sessionId: row.session_id,
    database,
    at,
  })
}
