import type { Database } from 'bun:sqlite'
import {
  HOSTED_COMMENT_TABLE,
  HOSTED_DAY_TABLE,
  HOSTED_DOCUMENT_TABLE,
  HOSTED_INTERVAL_TABLE,
  HOSTED_NOTE_ACKNOWLEDGEMENT_TABLE,
  HOSTED_NOTE_TABLE,
  HOSTED_STATUS_EVENT_TABLE,
  HOSTED_TASK_TABLE,
  type HostedPushChange,
  type PushedComment,
  type PushedDay,
  type PushedDocument,
  type PushedInterval,
  type PushedNote,
  type PushedNoteAcknowledgement,
} from './push-contract.ts'
import type { TaskRow } from './task.ts'
import { hostedTaskFromTaskRow } from './task-hosted-row.ts'

type OutboxPointer = {
  table_name: string
  row_id: string
  operation: 'upsert' | 'delete'
  routing_space_id?: string | null
  routing_project?: string | null
  routing_project_record_id?: string | null
  fields?: string | null
}

export type LoadedOutboxChange = {
  projectName: string | null
  acknowledgedSpaceId?: string | null
  change: HostedPushChange
}

function currentInterval(conn: Database, id: string): LoadedOutboxChange | null {
  const row = conn
    .query<PushedInterval & { hosted_space_id: string | null }, [string]>(
      `SELECT record_id id,task_key,project project_name,project_record_id projectId,source,agent,job,start_at,end_at,
      claude_tokens,vendor_tokens,vendor_cost_usd,ref,via,open,session_id,user_id,hosted_space_id
     FROM interval WHERE record_id=?`,
    )
    .get(id)
  if (!row) return null
  const { hosted_space_id, ...evidence } = row
  return {
    projectName: row.project_name,
    acknowledgedSpaceId: hosted_space_id,
    change: { table: HOSTED_INTERVAL_TABLE, id, op: 'upsert', row: evidence },
  }
}

function currentDay(conn: Database, id: string): LoadedOutboxChange | null {
  const row = conn
    .query<PushedDay, [string]>(
      `SELECT record_id id,machine_id,day,claude_tokens,cache_read,messages,tasks,canon_tokens,other_tokens,
      commits,files,lines_product,lines_test,lines_docs,lines_config,lines_generated,collected_at
     FROM day WHERE record_id=?`,
    )
    .get(id)
  if (row && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(row.collected_at))
    row.collected_at = new Date(`${row.collected_at.replace(' ', 'T')}Z`).toISOString()
  return row
    ? { projectName: null, change: { table: HOSTED_DAY_TABLE, id, op: 'upsert', row } }
    : null
}

function currentTask(conn: Database, id: string): LoadedOutboxChange | null {
  const row = conn.query<TaskRow, [string]>(`SELECT * FROM task WHERE record_id=?`).get(id)
  return row
    ? {
        projectName: row.project,
        change: { table: HOSTED_TASK_TABLE, id, op: 'upsert', row: hostedTaskFromTaskRow(row, id) },
      }
    : null
}

function currentComment(conn: Database, id: string): LoadedOutboxChange | null {
  const row = conn
    .query<PushedComment, [string]>(
      `SELECT c.record_id id,c.task_key,c.task_record_id task_id,t.project project_name,t.project_record_id projectId,
       c.body,c.created_at,c.updated_at,c.deleted_at,c.actor_user_id,c.actor_name,c.agent,c.run_id
       FROM task_comment c JOIN task t ON t.record_id=c.task_record_id WHERE c.record_id=?`,
    )
    .get(id)
  return row
    ? {
        projectName: row.project_name as string,
        change: { table: HOSTED_COMMENT_TABLE, id, op: 'upsert', row },
      }
    : null
}

function currentDocument(conn: Database, id: string): LoadedOutboxChange | null {
  const row = conn
    .query<PushedDocument, [string]>(
      `SELECT d.record_id id,d.number,d.task_key,d.task_record_id task_id,t.project project_name,t.project_record_id projectId,d.role,d.title,d.body,d.version,d.created_at,d.updated_at,NULL deleted_at FROM task_document d JOIN task t ON t.record_id=d.task_record_id WHERE d.record_id=?`,
    )
    .get(id)
  return row
    ? {
        projectName: row.project_name as string,
        change: { table: HOSTED_DOCUMENT_TABLE, id, op: 'upsert', row },
      }
    : null
}

function currentStatusEvent(conn: Database, id: string): LoadedOutboxChange | null {
  const row = conn
    .query<
      {
        id: string
        task_key: string
        task_id: string
        at: string
        from_status: string | null
        to_status: string
        project_name: string
        actor_user_id: string | null
        actor_name: string | null
        agent: string | null
        run_id: string | null
      },
      [string]
    >(
      `SELECT e.record_id id,e.task_key,e.task_record_id task_id,e.at,e.from_status,e.to_status,
        e.actor_user_id,e.actor_name,e.agent,e.run_id,
        t.project project_name,t.project_record_id projectId FROM task_status_event e
       JOIN task t ON t.record_id=e.task_record_id WHERE e.record_id=?`,
    )
    .get(id)
  return row
    ? {
        projectName: row.project_name,
        change: {
          table: HOSTED_STATUS_EVENT_TABLE,
          id,
          op: 'upsert',
          row: { ...row, created_at: row.at, updated_at: row.at, deleted_at: null },
        },
      }
    : null
}

function currentNote(conn: Database, id: string): LoadedOutboxChange | null {
  const row = conn
    .query<PushedNote, [string]>(
      `SELECT n.record_id id,n.number,n.project,n.project project_name,n.project_record_id projectId,n.text,n.area,n.anchors,
       n.sightings,n.created_at,n.last_seen_at,n.stale_at,n.stale_reason,n.promoted_task,
       n.promoted_task_record_id promoted_task_id,n.last_seen_at updated_at,NULL deleted_at
       FROM note n WHERE n.record_id=?`,
    )
    .get(id)
  return row
    ? {
        projectName: row.project,
        change: { table: HOSTED_NOTE_TABLE, id, op: 'upsert', row, fields: [] },
      }
    : null
}

function currentAcknowledgement(conn: Database, id: string): LoadedOutboxChange | null {
  const row = conn
    .query<PushedNoteAcknowledgement, [string]>(
      `SELECT a.record_id id,n.project project_name,n.project_record_id projectId,a.note_record_id note_id,a.session_id,
       a.acknowledged_at,a.sightings,a.acknowledged_at created_at,a.acknowledged_at updated_at,
       NULL deleted_at FROM note_acknowledgement a JOIN note n ON n.record_id=a.note_record_id
       WHERE a.record_id=?`,
    )
    .get(id)
  return row
    ? {
        projectName: row.project_name,
        change: { table: HOSTED_NOTE_ACKNOWLEDGEMENT_TABLE, id, op: 'upsert', row },
      }
    : null
}

export function loadOutboxChange(
  conn: Database,
  pointer: OutboxPointer,
): LoadedOutboxChange | null {
  if (pointer.operation === 'delete')
    return {
      projectName: pointer.routing_project ?? null,
      acknowledgedSpaceId: pointer.routing_space_id ?? null,
      change: {
        table: pointer.table_name as
          | typeof HOSTED_TASK_TABLE
          | typeof HOSTED_STATUS_EVENT_TABLE
          | typeof HOSTED_INTERVAL_TABLE
          | typeof HOSTED_DOCUMENT_TABLE,
        id: pointer.row_id,
        op: 'delete',
      },
    }
  if (pointer.table_name === HOSTED_TASK_TABLE) return currentTask(conn, pointer.row_id)
  if (pointer.table_name === HOSTED_COMMENT_TABLE) return currentComment(conn, pointer.row_id)
  if (pointer.table_name === HOSTED_DOCUMENT_TABLE) return currentDocument(conn, pointer.row_id)
  if (pointer.table_name === HOSTED_STATUS_EVENT_TABLE)
    return currentStatusEvent(conn, pointer.row_id)
  if (pointer.table_name === HOSTED_INTERVAL_TABLE) return currentInterval(conn, pointer.row_id)
  if (pointer.table_name === HOSTED_DAY_TABLE) return currentDay(conn, pointer.row_id)
  if (pointer.table_name === HOSTED_NOTE_TABLE) {
    const loaded = currentNote(conn, pointer.row_id)
    if (loaded?.change.op === 'upsert' && loaded.change.table === HOSTED_NOTE_TABLE)
      loaded.change.fields = pointer.fields ? JSON.parse(pointer.fields) : []
    return loaded
  }
  if (pointer.table_name === HOSTED_NOTE_ACKNOWLEDGEMENT_TABLE)
    return currentAcknowledgement(conn, pointer.row_id)
  return null
}
