// concern: hosted task-flow reads joined to local questions
/** Joins record-owned stages to the local question, run, project, and outbox rows. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_NAME } from '../../../shared/brand.ts'
import type { HostedTaskFlowStageById } from '../record/record-task-flow-contract.ts'
import { TASK_FLOW_STAGE_STATES } from '../record/record-task-flow-contract.ts'
import { questionOpenSql, questionTaskHolderSql } from '../run/question-open.ts'
import { type ListedItem, stageRow } from './task-flow-store-record-stage-row.ts'
import type {
  TaskFlowInboxQuestionRow,
  TaskFlowListedStageRow,
  TaskFlowOverturnRulingRow,
  TaskFlowQuestionCloseRow,
  TaskFlowRulingFileRow,
  TaskFlowRulingRow,
  TaskFlowTaskRulingRow,
} from './task-flow-store-types.ts'

type StageSelector = Record<string, unknown>
type StageRead = {
  list: (selector: StageSelector, project?: string) => Promise<ListedItem[]>
  listEvery: (selector: StageSelector) => Promise<ListedItem[]>
  byId: (id: string) => Promise<HostedTaskFlowStageById | null>
  projectId: (project: string) => string
}

type LocalQuestion = Record<string, unknown> & {
  number: number
  record_id: string
  workflow_cursor_record_id: string | null
}

const openQuestionRows = (database: Database) =>
  database.query<LocalQuestion, []>(`SELECT * FROM question q WHERE ${questionOpenSql('q')}`).all()

const stageMap = (items: ListedItem[]) => new Map(items.map((item) => [item.stage.id, item]))

function openQuestionByStage(database: Database) {
  const result = new Map<string, LocalQuestion>()
  for (const row of openQuestionRows(database).sort((a, b) => a.number - b.number)) {
    if (row.workflow_cursor_record_id && !result.has(row.workflow_cursor_record_id))
      result.set(row.workflow_cursor_record_id, row)
  }
  return result
}

function missingQuestionStage(row: LocalQuestion): never {
  throw new Error(
    `question ${row.number} names workflow stage ${row.workflow_cursor_record_id}, which the hosted record does not return; run ${PLATFORM_NAME} record push, then retry`,
  )
}

export const STAGE_BY_ID_READ_LIMIT = 20

async function readQuestionStages(read: StageRead, ids: string[]) {
  const stages = new Map<string, HostedTaskFlowStageById['stage']>()
  if (ids.length <= STAGE_BY_ID_READ_LIMIT) {
    for (const item of await Promise.all(ids.map((id) => read.byId(id))))
      if (item) stages.set(item.stage.id, item.stage)
    return stages
  }
  const wanted = new Set(ids)
  for (const { stage } of await read.listEvery({ states: TASK_FLOW_STAGE_STATES }))
    if (wanted.has(stage.id)) stages.set(stage.id, stage)
  return stages
}

async function stagesForQuestionRows(read: StageRead, rows: LocalQuestion[]) {
  const ids = [
    ...new Set(
      rows.flatMap((row) => (row.workflow_cursor_record_id ? [row.workflow_cursor_record_id] : [])),
    ),
  ]
  if (ids.length === 0) return new Map<string, HostedTaskFlowStageById['stage']>()
  const stages = await readQuestionStages(read, ids)
  for (const row of rows)
    if (row.workflow_cursor_record_id && !stages.has(row.workflow_cursor_record_id))
      missingQuestionStage(row)
  return stages
}

const questionStage = async (read: StageRead, row: LocalQuestion) => {
  if (!row.workflow_cursor_record_id) return null
  const stage = await read.byId(row.workflow_cursor_record_id)
  return stage ?? missingQuestionStage(row)
}

function listedStageReads(database: Database, read: StageRead) {
  return {
    async listOpenStages(input: {
      project?: string
      sessionId?: string
    }): Promise<TaskFlowListedStageRow[]> {
      const selector = {
        states: ['running', 'awaiting-ruling'],
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.project ? { projectId: read.projectId(input.project) } : {}),
      }
      const items = input.project
        ? await read.list(selector, input.project)
        : await read.listEvery(selector)
      const questionByStage = openQuestionByStage(database)
      return items
        .map((item) => {
          const row = stageRow(item)
          return {
            ...row,
            open_stage_count: row.open_stage_count!,
            question_number: questionByStage.get(item.stage.id)?.number ?? null,
          }
        })
        .sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.id - b.id)
    },

    async stageIdentityMap() {
      return (await read.listEvery({ states: TASK_FLOW_STAGE_STATES }))
        .map(({ stage }) => ({ number: stage.number, record_id: stage.id }))
        .sort((a, b) => a.number - b.number)
    },
  }
}

function waitingStageReads(database: Database, read: StageRead) {
  return {
    async waitingWorkflowQuestions() {
      const items = await read.listEvery({ states: ['awaiting-ruling'] })
      const stages = stageMap(items)
      return openQuestionRows(database).flatMap((q) => {
        const item = q.workflow_cursor_record_id
          ? stages.get(q.workflow_cursor_record_id)
          : undefined
        if (!item) return []
        const { stage } = item
        return [
          {
            id: stage.number,
            workflow_cursor_record_id: stage.id,
            project: stage.projectName!,
            question_record_id: q.record_id,
            task_key: (q.workflow_key as string | null) ?? null,
            question: q.question as string,
            waiting_since: q.asked_at as string,
            workflow_slug: stage.workflow,
            mode_slug: stage.mode,
            args: JSON.stringify(stage.arguments),
            session_id: stage.sessionId ?? null,
          },
        ]
      })
    },

    async closeOutShipTaskStage(sessionId: string, project: string, branch: string) {
      return (
        await read.list(
          {
            projectId: read.projectId(project),
            sessionId,
            workflow: 'ship-task',
            states: ['running', 'awaiting-ruling'],
          },
          project,
        )
      )
        .filter(({ stage }) => stage.arguments.branch === branch)
        .map(({ stage }) => ({
          id: stage.number,
          step_slug: stage.activeSlug,
          workflow_slug: stage.workflow,
          project: stage.projectName!,
          args: JSON.stringify(stage.arguments),
        }))
        .sort((a, b) => a.id - b.id)
    },
  }
}

function sessionStageReads(database: Database, read: StageRead) {
  return {
    async cursorWorkForSession(sessionId: string) {
      return (await read.listEvery({ sessionId }))
        .filter(({ stage }) => Boolean(stage.workflowKey))
        .map(({ stage }) => ({
          key: stage.workflowKey!,
          closed: JSON.stringify(stage.closedStepNotes),
        }))
    },

    async cursorLifecycleForSession(sessionId: string) {
      return (await read.listEvery({ sessionId })).map(({ stage }) => ({
        record_id: stage.id,
        number: stage.number,
        created_at: stage.createdAt,
        updated_at: stage.updatedAt,
        state: stage.state,
        closed: JSON.stringify(stage.closedStepNotes),
      }))
    },

    async openStagesForSession(sessionId: string) {
      const items = await read.listEvery({
        sessionId,
        states: ['running', 'awaiting-ruling'],
      })
      const openByStage = openQuestionByStage(database)
      return items
        .map(({ stage }) => ({
          record_id: stage.id,
          number: stage.number,
          project: stage.projectName!,
          workflow_slug: stage.workflow,
          workflow_key: stage.workflowKey ?? '',
          state: stage.state,
          open_question_record_id: openByStage.get(stage.id)?.record_id ?? null,
        }))
        .sort((a, b) => a.number - b.number)
    },

    async keylessSessionCursors(project: string | null) {
      const selector = {
        keyless: true,
        states: ['running', 'awaiting-ruling'],
        ...(project ? { projectId: read.projectId(project) } : {}),
      }
      const items = project ? await read.list(selector, project) : await read.listEvery(selector)
      const openByStage = openQuestionByStage(database)
      return items
        .filter(({ stage }) => stage.sessionId !== null)
        .map(({ stage }) => ({
          record_id: stage.id,
          number: stage.number,
          project: stage.projectName!,
          workflow_slug: stage.workflow,
          step_slug: stage.activeSlug,
          session_id: stage.sessionId!,
          updated_at: stage.updatedAt,
          open_question_record_id: openByStage.get(stage.id)?.record_id ?? null,
        }))
        .sort((a, b) => a.number - b.number)
    },
  }
}

function inboxStageReads(database: Database, read: StageRead) {
  return {
    async openWorkflowQuestionCountForSession(sessionId: string) {
      const ids = new Set((await read.listEvery({ sessionId })).map(({ stage }) => stage.id))
      return openQuestionRows(database).filter(
        (q) => q.workflow_cursor_record_id && ids.has(q.workflow_cursor_record_id),
      ).length
    },

    async workflowInboxQuestions(): Promise<TaskFlowInboxQuestionRow[]> {
      const items = await read.listEvery({ states: ['awaiting-ruling'] })
      const stages = stageMap(items)
      return openQuestionRows(database)
        .flatMap((q) => {
          const stage = q.workflow_cursor_record_id
            ? stages.get(q.workflow_cursor_record_id)?.stage
            : undefined
          return stage
            ? [
                {
                  number: q.number,
                  record_id: q.record_id,
                  asked_at: q.asked_at as string,
                  question: q.question as string,
                  cursor_record_id: stage.number,
                  project: stage.projectName!,
                  project_record_id: stage.projectId,
                  workflow_slug: stage.workflow,
                  mode_slug: stage.mode,
                  args: JSON.stringify(stage.arguments),
                  ordinal: stage.activeOrdinal,
                  step_slug: stage.activeSlug,
                  session_id: stage.sessionId ?? null,
                },
              ]
            : []
        })
        .sort((a, b) => a.asked_at.localeCompare(b.asked_at) || a.number - b.number)
    },
  }
}

function rulingListReads(database: Database, read: StageRead) {
  return {
    async rulingRows(input: {
      kind: 'workflow' | 'run' | 'all'
      since?: string
      after: number | null
      cursor: number | null
    }): Promise<TaskFlowRulingRow[]> {
      const clauses: string[] = []
      const values: string[] = []
      if (input.kind === 'workflow') clauses.push('q.workflow_cursor_record_id IS NOT NULL')
      else if (input.kind === 'run') clauses.push('q.run_record_id IS NOT NULL')
      if (input.since) {
        clauses.push(
          `(${questionOpenSql('q')} OR q.asked_at>=? OR q.answered_at>=? OR q.closed_at>=? OR q.overturned_at>=? OR q.filed_at>=?)`,
        )
        values.push(input.since, input.since, input.since, input.since, input.since)
      }
      if (input.after !== null) {
        clauses.push('q.change_seq>? AND q.change_seq<=?')
        values.push(String(input.after), String(input.cursor))
      }
      const rows = database
        .query<LocalQuestion, string[]>(
          `SELECT q.number,q.record_id,q.run_record_id,r.number AS run_number,
                  q.workflow_cursor_record_id,q.workflow_key,r.repo run_project,r.session_id run_session,
                  q.asked_at,q.question,q.answer,q.answer_basis,q.answered_at,
                  q.answered_by,q.answered_by_name,q.asked_via,q.answerer_kind,q.answer_channel,
                  q.closed_at,q.close_reason,q.overturned_at,q.overturned_by,q.overturned_by_name,
                  q.overturn_reason,q.replacement,q.filed_as,q.filed_ref,q.filed_record_id,
                  q.filed_label,q.filed_at
           FROM question q LEFT JOIN run r ON r.record_id=q.run_record_id
          ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY q.number`,
        )
        .all(...values)
      const stages = await stagesForQuestionRows(read, rows)
      return rows.map((q) => {
        const stage = q.workflow_cursor_record_id
          ? stages.get(q.workflow_cursor_record_id)
          : undefined
        const {
          run_project: _runProject,
          run_session: _runSession,
          workflow_cursor_record_id: _workflowCursorRecordId,
          ...row
        } = q
        return {
          ...row,
          workflow_cursor_id: q.workflow_cursor_record_id,
          project: (q.run_project as string | null) ?? stage?.projectName ?? null,
          workflow_slug: stage?.workflow ?? null,
          mode_slug: stage?.mode ?? null,
          session_id: (q.run_session as string | null) ?? stage?.sessionId ?? null,
        }
      })
    },
  }
}

function rulingFileReads(database: Database, read: StageRead) {
  return {
    async rulingFileQuestion(questionId: string): Promise<TaskFlowRulingFileRow | null> {
      const q = database
        .query<LocalQuestion & Record<string, unknown>, [string]>(
          `SELECT q.number,q.record_id,q.run_record_id,COALESCE(r.parent_run_record_id,r.record_id) root_id,
                  q.workflow_cursor_record_id,q.question,q.answer,q.answer_basis,q.answered_at,
                  q.answered_by,q.answered_by_name,q.answerer_kind,q.overturned_at,q.overturned_by,
                  q.overturned_by_name,q.replacement,q.filed_as,q.filed_ref,q.filed_record_id,
                  q.filed_label,q.filed_at,
                  q.workflow_key,
                r.repo run_repo,r.cwd run_cwd,${questionTaskHolderSql('q', 'r')} launch_key
           FROM question q LEFT JOIN run r ON r.record_id=q.run_record_id WHERE q.record_id=?`,
        )
        .get(questionId)
      if (!q) return null
      const stage = (await questionStage(read, q))?.stage
      const project = stage
        ? database
            .query<{ path: string }, [string]>(
              'SELECT path FROM project WHERE record_id=? AND retired_at IS NULL',
            )
            .get(stage.projectId)
        : null
      const { run_repo: _runRepo, run_cwd: _runCwd, workflow_key: _workflowKey, ...row } = q
      return {
        ...(row as unknown as TaskFlowRulingFileRow),
        workflow_cursor_number: stage?.number ?? null,
        workflow_slug: stage?.workflow ?? null,
        mode_slug: stage?.mode ?? null,
        workflow_owner: stage?.sessionId ?? null,
        workflow_updated_at: stage?.updatedAt ?? null,
        repo: (q.run_repo as string | null) ?? stage?.projectName ?? null,
        cwd: (q.run_cwd as string | null) ?? project?.path ?? null,
        project_path: project?.path ?? null,
        args: stage ? JSON.stringify(stage.arguments) : null,
      }
    },
  }
}

function rulingMutationReads(database: Database, read: StageRead) {
  return {
    async questionCloseFacts(questionId: string): Promise<TaskFlowQuestionCloseRow | null> {
      const q = database
        .query<LocalQuestion & TaskFlowQuestionCloseRow, [string]>(
          `SELECT q.answered_at,q.closed_at,q.run_record_id,q.workflow_cursor_record_id,
                COALESCE(owner.parent_run_record_id,owner.record_id) root_id,
                (SELECT latest.status FROM run latest
                  WHERE latest.record_id=COALESCE(owner.parent_run_record_id,owner.record_id)
                     OR latest.parent_run_record_id=COALESCE(owner.parent_run_record_id,owner.record_id)
                  ORDER BY latest.turn DESC,latest.number DESC LIMIT 1) latest_status,
                q.number,q.record_id
           FROM question q LEFT JOIN run owner ON owner.record_id=q.run_record_id WHERE q.record_id=?`,
        )
        .get(questionId)
      if (!q) return null
      const { number: _number, record_id: _recordId, ...row } = q
      return { ...row, cursor_state: (await questionStage(read, q))?.stage.state ?? null }
    },

    async overturnRulingRow(questionId: string): Promise<TaskFlowOverturnRulingRow | null> {
      const q = database
        .query<LocalQuestion & TaskFlowOverturnRulingRow, [string]>(
          `SELECT q.number,q.record_id,q.run_record_id,COALESCE(owner.parent_run_record_id,owner.record_id) root_id,
                q.workflow_cursor_record_id,q.answered_at,q.overturned_at,q.overturned_by,q.overturned_by_name,
                q.overturn_reason,q.replacement
           FROM question q LEFT JOIN run owner ON owner.record_id=q.run_record_id WHERE q.record_id=?`,
        )
        .get(questionId)
      if (!q) return null
      const stage = (await questionStage(read, q))?.stage
      return {
        ...q,
        workflow_owner: stage?.sessionId ?? null,
        workflow_updated_at: stage?.updatedAt ?? null,
      }
    },
  }
}

function questionLinkReads(database: Database, read: StageRead) {
  return {
    async pendingQuestionTaskLinks() {
      const rows = database
        .query<LocalQuestion, []>(
          `SELECT * FROM question q
          WHERE q.workflow_task_record_id IS NULL AND q.workflow_key IS NOT NULL`,
        )
        .all()
      const stages = await stagesForQuestionRows(read, rows)
      return rows
        .map((q) => {
          const stage = q.workflow_cursor_record_id
            ? stages.get(q.workflow_cursor_record_id)
            : undefined
          return stage
            ? { id: q.record_id, task_key: q.workflow_key as string, project: stage.projectName! }
            : null
        })
        .filter((row) => row !== null)
    },

    async linkedQuestionTaskReferences() {
      const rows = database
        .query<LocalQuestion, []>(
          'SELECT * FROM question q WHERE q.workflow_task_record_id IS NOT NULL',
        )
        .all()
      const stages = await stagesForQuestionRows(read, rows)
      return rows
        .map((q) => {
          const stage = q.workflow_cursor_record_id
            ? stages.get(q.workflow_cursor_record_id)
            : undefined
          return stage
            ? { task_record_id: q.workflow_task_record_id as string, project: stage.projectName! }
            : null
        })
        .filter((row) => row !== null)
    },
  }
}

function taskRulingReads(database: Database, read: StageRead) {
  return {
    async taskRulingRows(
      project: string,
      taskRecordId: string,
      limit: number,
    ): Promise<TaskFlowTaskRulingRow[]> {
      const runRows = database
        .query<TaskFlowTaskRulingRow & { effective_at: string }, [string, string]>(
          `SELECT q.number question_id,q.record_id question_record_id,root.record_id run_record_id,NULL workflow_cursor_record_id,
                q.question,q.answer,q.answer_basis,q.answered_at,q.answerer_kind,q.answered_by_name,
                q.overturned_at,q.overturned_by_name,q.replacement,COALESCE(q.overturned_at,q.answered_at) effective_at,0 candidate_count
           FROM question q JOIN run owner ON owner.record_id=q.run_record_id
           JOIN run root ON root.record_id=COALESCE(owner.parent_run_record_id,owner.record_id)
          WHERE root.project_record_id=(SELECT record_id FROM project WHERE name=?) AND root.task_record_id=?
            AND q.answered_at IS NOT NULL AND NOT (q.overturned_at IS NOT NULL AND q.replacement IS NULL)`,
        )
        .all(project, taskRecordId)
      const workflowRows = database
        .query<LocalQuestion & TaskFlowTaskRulingRow & { effective_at: string }, [string]>(
          `SELECT q.number question_id,q.record_id question_record_id,NULL run_record_id,q.workflow_cursor_record_id,
                q.question,q.answer,q.answer_basis,q.answered_at,q.answerer_kind,q.answered_by_name,
                q.overturned_at,q.overturned_by_name,q.replacement,COALESCE(q.overturned_at,q.answered_at) effective_at,
                0 candidate_count
           FROM question q WHERE q.workflow_task_record_id=? AND q.answered_at IS NOT NULL
            AND NOT (q.overturned_at IS NOT NULL AND q.replacement IS NULL)`,
        )
        .all(taskRecordId)
      const projectId = read.projectId(project)
      const stages = await stagesForQuestionRows(read, workflowRows)
      const matchingWorkflow = [] as Array<TaskFlowTaskRulingRow & { effective_at: string }>
      for (const row of workflowRows) {
        const stage = row.workflow_cursor_record_id
          ? stages.get(row.workflow_cursor_record_id)
          : null
        if (stage?.projectId === projectId) matchingWorkflow.push(row)
      }
      const rows = [...runRows, ...matchingWorkflow]
      const candidateCount = rows.length
      return rows
        .sort(
          (a, b) => b.effective_at.localeCompare(a.effective_at) || b.question_id - a.question_id,
        )
        .slice(0, limit)
        .map(({ effective_at: _effectiveAt, ...row }) => ({
          ...row,
          candidate_count: candidateCount,
        }))
    },
  }
}

function questionProjectReads(database: Database, read: StageRead) {
  return {
    async localQuestionProjects() {
      const rows = database
        .query<LocalQuestion & { run_project: string | null }, []>(
          `SELECT q.*,run_project.name run_project FROM question q
         LEFT JOIN run r ON r.record_id=q.run_record_id
         LEFT JOIN project run_project ON run_project.record_id=r.project_record_id
        WHERE q.run_record_id IS NULL OR EXISTS (
          SELECT 1 FROM outbox o WHERE o.kind='run' AND o.row_id=r.record_id AND o.synced_at IS NOT NULL
        )`,
        )
        .all()
      const stages = await stagesForQuestionRows(read, rows)
      return rows.map((q) => ({
        project:
          q.run_project ??
          (q.workflow_cursor_record_id
            ? stages.get(q.workflow_cursor_record_id)?.projectName
            : null) ??
          null,
      }))
    },
  }
}

export function recordQuestionReads(database: Database, read: StageRead) {
  return {
    ...listedStageReads(database, read),
    ...waitingStageReads(database, read),
    ...sessionStageReads(database, read),
    ...inboxStageReads(database, read),
    ...rulingListReads(database, read),
    ...rulingFileReads(database, read),
    ...rulingMutationReads(database, read),
    ...questionLinkReads(database, read),
    ...taskRulingReads(database, read),
    ...questionProjectReads(database, read),
  }
}
