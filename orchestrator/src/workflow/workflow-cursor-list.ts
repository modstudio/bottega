// concern: workflow cursor listing
/** Lists cursors with their next step and unresolved floor obligations. */

import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import { projectAt } from '../project/projects.ts'
import { openQuestionStages } from '../question-store/question-store-read.ts'
import { isOpenStageState, TASK_FLOW_STAGE_STATES } from '../record/record-task-flow-contract.ts'
import { LIVE_RUN_STATUS_SQL } from '../run/run-status.ts'
import {
  type TaskFlowListedStageRow as ListedCursorRow,
  taskFlowHandoffLinks,
  taskFlowReadStore,
} from './task-flow-store.ts'
import { cursorAutonomy } from './workflow-cursor-autonomy.ts'
import { renderWorkflowCursorLine } from './workflow-cursor-format.ts'
import { workflowCursorProjectScope } from './workflow-cursor-selection.ts'
import { openWorkflowObligations } from './workflow-obligation-floor.ts'
import { composeWorkflow } from './workflows.ts'

export type CursorListOptions = {
  session?: string
  all?: boolean
  project?: string
  cwd?: string
}

export type WorkflowCursorListRow = ListedCursorRow & {
  next_slug: string
  line: string
  live_runs: Array<{ number: number; record_id: string }>
}

/** The one workflow-owned read defining open keyless context holders for a session. */
export async function openKeylessCursorsForSession(session: string, d: Database = db()) {
  return (await openQuestionStages(d, session)).filter((cursor) => !cursor.workflow_key)
}

export async function workflowCursorHandoffLinks(
  cursors: readonly Pick<WorkflowCursorListRow, 'record_id'>[],
  d: Database = db(),
) {
  return taskFlowHandoffLinks(
    taskFlowReadStore(d),
    cursors.map((cursor) => cursor.record_id),
  )
}

/** Reads the run-owned live bindings for the selected workflow cursors. */
export function liveRunCursorIds(cursorRecordIds: readonly string[], d: Database = db()): string[] {
  if (!cursorRecordIds.length) return []
  const placeholders = cursorRecordIds.map(() => '?').join(',')
  return d
    .query<{ cursor_record_id: string }, string[]>(
      `SELECT DISTINCT cursor_record_id FROM run
       WHERE cursor_record_id IN (${placeholders}) AND status IN ${LIVE_RUN_STATUS_SQL}`,
    )
    .all(...cursorRecordIds)
    .map((row) => row.cursor_record_id)
}

export async function listWorkflowCursors(
  options: CursorListOptions = {},
  d: Database = db(),
): Promise<WorkflowCursorListRow[]> {
  const cwd = options.cwd ?? process.cwd()
  const cwdProject =
    options.all || options.project || options.session ? undefined : projectAt(cwd)?.name
  const project = workflowCursorProjectScope(options, cwdProject, cwd)
  const selector = {
    ...(project ? { project } : {}),
    ...(options.session ? { sessionId: options.session } : {}),
  }
  const store = taskFlowReadStore(d)
  const rows = options.all
    ? await store.listStages({ ...selector, states: TASK_FLOW_STAGE_STATES })
    : await store.listOpenStages(selector)
  const liveRunsByCursor = new Map<string, Array<{ number: number; record_id: string }>>()
  if (rows.length) {
    const placeholders = rows.map(() => '?').join(',')
    const liveRuns = d
      .query<{ number: number; record_id: string; cursor_record_id: string }, string[]>(
        `SELECT number,record_id,cursor_record_id FROM run
         WHERE cursor_record_id IN (${placeholders}) AND status IN ${LIVE_RUN_STATUS_SQL}
         ORDER BY number`,
      )
      .all(...rows.map((row) => row.record_id))
    for (const run of liveRuns) {
      const current = liveRunsByCursor.get(run.cursor_record_id) ?? []
      current.push({ number: run.number, record_id: run.record_id })
      liveRunsByCursor.set(run.cursor_record_id, current)
    }
  }
  return await Promise.all(
    rows.map(async (row) => {
      const handedOffFrom = row.handed_off_from_record_id
        ? await taskFlowReadStore(d).stageByRecordId(row.handed_off_from_record_id)
        : null
      const closed = !isOpenStageState(row.state)
      const composition = closed
        ? null
        : composeWorkflow(
            row.workflow_slug,
            row.project,
            row.mode_slug,
            JSON.parse(row.args),
            d,
            {
              version: row.workflow_version,
              versionRecordId: row.workflow_version_record_id,
              catalogueVersion: row.catalogue_version,
              catalogueVersionRecordId: row.catalogue_version_record_id,
            },
            cursorAutonomy(row),
          )
      const open = closed ? [] : await openWorkflowObligations(row.record_id, d)
      const liveRuns = liveRunsByCursor.get(row.record_id) ?? []
      const listed = {
        ...row,
        next_slug: composition?.steps[row.ordinal + 1]?.slug ?? 'finished',
        obligations: open
          .map((item) => `${item.id}(${item.stepSlug}:${item.floorDefinition.kind})`)
          .join(','),
        handed_off_from_number: handedOffFrom?.id ?? null,
        handed_off_from_workflow: handedOffFrom?.workflow_slug ?? null,
        live_runs: liveRuns,
      }
      return { ...listed, line: renderWorkflowCursorLine(listed) }
    }),
  )
}
