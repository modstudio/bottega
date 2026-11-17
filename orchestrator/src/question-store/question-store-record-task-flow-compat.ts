// concern: hosted task-flow reads joined through the question port
/** Decorates record-owned stages with question facts from the selected question store. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_NAME } from '../../../shared/brand.ts'
import { QUESTION_ID_LIST_LIMIT } from '../record/record-question-contract.ts'
import type { HostedTaskFlowStageById } from '../record/record-task-flow-contract.ts'
import { TASK_FLOW_STAGE_STATES } from '../record/record-task-flow-contract.ts'
import { type ListedItem, stageRow } from '../workflow/task-flow-store-record-stage-row.ts'
import type {
  TaskFlowInboxQuestionRow,
  TaskFlowListedStageRow,
  TaskFlowOpenSessionStageRow,
  TaskFlowOverturnRulingRow,
  TaskFlowQuestionCloseRow,
  TaskFlowRulingFileRow,
  TaskFlowRulingRow,
  TaskFlowTaskRulingRow,
  TaskFlowWaitingQuestionRow,
} from '../workflow/task-flow-store-types.ts'
import { questionStore } from './question-store.ts'
import { questionRulingsPaged } from './question-store-read.ts'
import type { QuestionReadRow, QuestionStore } from './question-store-types.ts'

type StageSelector = Record<string, unknown>
type StageRead = {
  list: (selector: StageSelector, project?: string) => Promise<ListedItem[]>
  listEvery: (selector: StageSelector) => Promise<ListedItem[]>
  byId: (id: string) => Promise<HostedTaskFlowStageById | null>
  projectId: (project: string) => string
}

const field = (row: QuestionReadRow, name: string): unknown =>
  (row as Record<string, unknown>)[name]
const openQuestionMap = (rows: QuestionReadRow[]) =>
  new Map(
    rows.flatMap((row) => {
      const cursor = field(row, 'workflow_cursor_record_id')
      return typeof cursor === 'string' ? [[cursor, row] as const] : []
    }),
  )

function checkedDetail(row: QuestionReadRow | undefined): QuestionReadRow | null {
  if (!row) return null
  const cursor = field(row, 'workflow_cursor_record_id')
  if (typeof cursor === 'string' && field(row, 'workflow_cursor_number') == null) {
    throw new Error(
      `question ${String(field(row, 'number'))} names workflow stage ${cursor}, which the hosted record does not return; run ${PLATFORM_NAME} record push, then retry`,
    )
  }
  return row
}

function fields<T>(row: QuestionReadRow, names: readonly string[]): T {
  return Object.fromEntries(names.map((name) => [name, field(row, name)])) as T
}

async function openForStages(questions: QuestionStore, ids: string[]) {
  if (ids.length === 0) return new Map<string, QuestionReadRow>()
  const rows: QuestionReadRow[] = []
  for (let offset = 0; offset < ids.length; offset += QUESTION_ID_LIST_LIMIT)
    rows.push(
      ...(
        await questions.read({
          read: 'open-for-cursors',
          workflowCursorRecordIds: ids.slice(offset, offset + QUESTION_ID_LIST_LIMIT),
        })
      ).items,
    )
  return openQuestionMap(rows)
}

function stageReads(questions: QuestionStore, read: StageRead) {
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
      const open = await openForStages(
        questions,
        items.map(({ stage }) => stage.id),
      )
      return items
        .map((item) => {
          const row = stageRow(item)
          const question = open.get(item.stage.id)
          const questionNumber = field(question ?? {}, 'number')
          return {
            ...row,
            open_stage_count: row.open_stage_count!,
            question_number: typeof questionNumber === 'number' ? questionNumber : null,
          }
        })
        .sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.id - b.id)
    },

    async stageIdentityMap() {
      return (await read.listEvery({ states: TASK_FLOW_STAGE_STATES }))
        .map(({ stage }) => ({ number: stage.number, record_id: stage.id }))
        .sort((a, b) => a.number - b.number)
    },

    async waitingWorkflowQuestions(): Promise<TaskFlowWaitingQuestionRow[]> {
      return (await questions.read({ read: 'waiting' })).items as TaskFlowWaitingQuestionRow[]
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

function sessionReads(questions: QuestionStore, read: StageRead) {
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
        workflow_slug: stage.workflow,
        workflow_key: stage.workflowKey ?? null,
        created_at: stage.createdAt,
        updated_at: stage.updatedAt,
        state: stage.state,
        closed: JSON.stringify(stage.closedStepNotes),
      }))
    },

    async openStagesForSession(sessionId: string): Promise<TaskFlowOpenSessionStageRow[]> {
      return (await questions.read({ read: 'open-for-session', sessionId }))
        .items as TaskFlowOpenSessionStageRow[]
    },

    async keylessSessionCursors(project: string | null) {
      const selector = {
        keyless: true,
        states: ['running', 'awaiting-ruling'],
        ...(project ? { projectId: read.projectId(project) } : {}),
      }
      const items = project ? await read.list(selector, project) : await read.listEvery(selector)
      const open = await openForStages(
        questions,
        items.map(({ stage }) => stage.id),
      )
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
          open_question_record_id:
            (field(open.get(stage.id) ?? {}, 'record_id') as string | undefined) ?? null,
        }))
        .sort((a, b) => a.number - b.number)
    },

    async workflowInboxQuestions(): Promise<TaskFlowInboxQuestionRow[]> {
      return (await questions.read({ read: 'inbox' })).items.filter(
        (row): row is TaskFlowInboxQuestionRow =>
          typeof field(row, 'cursor_record_id') === 'number',
      )
    },
  }
}

function rulingListReads(questions: QuestionStore) {
  return {
    async rulingRows(input: {
      kind: 'workflow' | 'run' | 'all'
      since?: string
      after: number | null
      cursor: number | null
    }): Promise<TaskFlowRulingRow[]> {
      const rows: QuestionReadRow[] = input.since
        ? (await questions.read({ read: 'rulings', kind: input.kind, since: input.since })).items
        : ((await questionRulingsPaged(questions, input.kind)) as QuestionReadRow[])
      for (const row of rows) {
        const cursor = field(row, 'workflow_cursor_id')
        if (typeof cursor === 'string' && field(row, 'workflow_slug') == null)
          throw new Error(
            `question ${String(field(row, 'number'))} names workflow stage ${cursor}, which the hosted record does not return; run ${PLATFORM_NAME} record push, then retry`,
          )
      }
      return rows as TaskFlowRulingRow[]
    },
  }
}

const RULING_FILE_FIELDS = [
  'record_id',
  'number',
  'run_record_id',
  'root_id',
  'workflow_cursor_record_id',
  'workflow_cursor_number',
  'workflow_slug',
  'mode_slug',
  'workflow_owner',
  'workflow_updated_at',
  'question',
  'answer',
  'answer_basis',
  'answered_at',
  'answered_by',
  'answered_by_name',
  'answerer_kind',
  'overturned_at',
  'overturned_by',
  'overturned_by_name',
  'replacement',
  'filed_as',
  'filed_ref',
  'filed_record_id',
  'filed_label',
  'filed_at',
  'repo',
  'cwd',
  'launch_key',
  'project_path',
  'args',
] as const

function detailReads(questions: QuestionStore) {
  return {
    async rulingFileQuestion(questionId: string): Promise<TaskFlowRulingFileRow | null> {
      const row = checkedDetail(
        (await questions.read({ read: 'by-id', ids: [questionId] })).items[0],
      )
      return row ? fields<TaskFlowRulingFileRow>(row, RULING_FILE_FIELDS) : null
    },

    async questionCloseFacts(questionId: string): Promise<TaskFlowQuestionCloseRow | null> {
      const row = checkedDetail(
        (await questions.read({ read: 'by-id', ids: [questionId] })).items[0],
      )
      return row
        ? fields<TaskFlowQuestionCloseRow>(row, [
            'answered_at',
            'closed_at',
            'run_record_id',
            'workflow_cursor_record_id',
            'cursor_state',
            'root_id',
            'latest_status',
          ])
        : null
    },

    async overturnRulingRow(questionId: string): Promise<TaskFlowOverturnRulingRow | null> {
      const row = checkedDetail(
        (await questions.read({ read: 'by-id', ids: [questionId] })).items[0],
      )
      return row
        ? fields<TaskFlowOverturnRulingRow>(row, [
            'record_id',
            'number',
            'run_record_id',
            'root_id',
            'workflow_cursor_record_id',
            'workflow_owner',
            'workflow_updated_at',
            'answered_at',
            'overturned_at',
            'overturned_by',
            'overturned_by_name',
            'overturn_reason',
            'replacement',
          ])
        : null
    },
  }
}

function aggregateReads(questions: QuestionStore, read: StageRead) {
  return {
    async taskRulingRows(
      project: string,
      taskRecordId: string,
      limit: number,
    ): Promise<TaskFlowTaskRulingRow[]> {
      return (
        await questions.read({
          read: 'task-rulings',
          projectId: read.projectId(project),
          taskId: taskRecordId,
          limit,
        })
      ).items as TaskFlowTaskRulingRow[]
    },

    async localQuestionProjects() {
      return (await questions.read({ read: 'projects' })).items as Array<{
        project: string | null
      }>
    },
  }
}

export function recordQuestionReads(database: Database, read: StageRead) {
  const questions = questionStore(database)
  return {
    ...stageReads(questions, read),
    ...sessionReads(questions, read),
    ...rulingListReads(questions),
    ...detailReads(questions),
    ...aggregateReads(questions, read),
  }
}
