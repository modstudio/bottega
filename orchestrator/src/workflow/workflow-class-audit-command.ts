// concern: workflows
/** Thin read-only adapter for the workflow class audit. */

import { flagValue } from '../cli/args.ts'
import { db } from '../database/db.ts'
import { listHubNotes } from '../mcp/hub-notes.ts'
import { auditUnmeasuredDefectCursors } from './workflow-class-audit.ts'
import type { WorkflowPrint } from './workflow-commands.ts'
import { listWorkflowCursors } from './workflow-cursor-list.ts'
import { closedStepsFromTrail } from './workflow-cursor-trail.ts'

export async function classAuditCommand(argv: string[], print: WorkflowPrint): Promise<void> {
  const since = flagValue(argv, 'since')
  if (!since || Number.isNaN(Date.parse(since))) throw new Error('--since must be an ISO date')
  const cursors = await listWorkflowCursors({ all: true })
  const relevant = cursors.filter(
    (cursor) => cursor.workflow_slug === 'fix-defect' || cursor.workflow_slug === 'plan-task',
  )
  const projects = [...new Set(relevant.map((cursor) => cursor.project))]
  const noteRows = (
    await Promise.all(projects.map((project) => listHubNotes(project, { cwd: process.cwd() })))
  ).flatMap((notes, index) =>
    notes.flatMap((note) =>
      note.promoted_task ? [{ project: projects[index]!, key: note.promoted_task }] : [],
    ),
  )
  const implementRuns = db()
    .query<
      { cursor_record_id: string | null; task_record_id: string | null; started_at: string },
      []
    >("SELECT cursor_record_id,task_record_id,started_at FROM run WHERE job='implement'")
    .all()
    .map((run) => ({
      cursorRecordId: run.cursor_record_id,
      taskRecordId: run.task_record_id,
      startedAt: run.started_at,
    }))
  const result = auditUnmeasuredDefectCursors({
    since: new Date(since).toISOString(),
    cursors: relevant.map((cursor) => ({
      number: cursor.number,
      recordId: cursor.record_id,
      project: cursor.project,
      workflow: cursor.workflow_slug,
      key: cursor.workflow_key,
      taskRecordId: cursor.task_record_id,
      createdAt: cursor.created_at,
      closed: closedStepsFromTrail(cursor.closed),
    })),
    promoted: noteRows,
    implementRuns,
  })
  print(
    result,
    `${result.cursors.map((cursor) => `${cursor.number} ${cursor.workflow} ${cursor.key}`).join('\n')}${result.cursors.length ? '\n' : ''}${result.count}`,
  )
}
