import { db } from './db.ts'
import { projects } from './projects.ts'
import { runRef } from './reconcile.ts'
import { localTaskDetail, type TaskDetail } from './task-detail.ts'
import { getLocalTaskDocument, type TaskDocumentSummary } from './task-document.ts'
import type { TaskRow } from './task-row.ts'
import type { TaskComment } from './task-types.ts'
import { taskWriteDecision } from './task-write-destination.ts'
import { trackerCapabilities } from './tracker-capabilities.ts'

export type TaskRecordRows = {
  task: TaskRow
  comments: TaskComment[]
  documents: TaskDocumentSummary[]
}

export function taskRecordFromRows(
  record: TaskRecordRows,
  readerUserId: string | null,
): TaskDetail {
  const project = projects().find((candidate) => candidate.name === record.task.project) ?? null
  const documents = record.documents
    .map((document) =>
      document.body !== undefined &&
      document.version !== undefined &&
      document.created_at !== undefined
        ? {
            ...document,
            body: document.body,
            version: document.version,
            created_at: document.created_at,
          }
        : getLocalTaskDocument(document.id),
    )
    .sort((a, b) => Number(b.role === 'handoff') - Number(a.role === 'handoff'))
  const runs = db()
    .query<
      {
        ref: string
        agent: string | null
        job: string | null
        started_at: string
        ended_at: string
        running: number
        vendor_tokens: number
        vendor_cost_usd: number | null
      },
      [string]
    >(
      `SELECT ref, agent, job, MIN(start_at) started_at, MAX(end_at) ended_at,
              MAX(open) running, SUM(vendor_tokens) vendor_tokens,
              SUM(vendor_cost_usd) vendor_cost_usd
         FROM interval WHERE task_record_id = ? AND source = 'orch'
        GROUP BY ref, agent, job ORDER BY started_at DESC`,
    )
    .all(record.task.record_id)
    .flatMap((run) => {
      const parsed = runRef(run.ref)
      return parsed
        ? [
            {
              ...run,
              id: parsed.turn ?? parsed.root,
              source: 'orch',
              running: Boolean(run.running),
            },
          ]
        : []
    })
  const statusEvents = db()
    .query<
      {
        id: string
        at: string
        from_status: string | null
        to_status: string
        actor_name: string | null
        agent: string | null
      },
      [string]
    >(
      `SELECT record_id AS id, at, from_status, to_status,actor_name,agent FROM task_status_event
       WHERE task_record_id = ? ORDER BY at, record_id`,
    )
    .all(record.task.record_id)
  return localTaskDetail(
    {
      task: {
        ...record.task,
        source_protocol:
          record.task.source === 'mcp' ? (project?.settings.tracker?.protocol ?? null) : null,
      },
      capabilities: trackerCapabilities({ source: record.task.source, project }),
      runs,
      comments: record.comments,
      documents,
      statusEvents,
    },
    readerUserId,
    taskWriteDecision(record.task.project),
  )
}
