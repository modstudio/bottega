// concern: sqlite-question-store
/** Adapts the existing SQLite question rows to the question port. */

import type { Database } from 'bun:sqlite'
import { nextEntityNumber } from '../database/entity-number.ts'
import type {
  QuestionIntent,
  QuestionReadInput,
  QuestionWriteBody,
  QuestionWriteResult,
} from '../record/record-question-contract.ts'
import {
  assertQuestionJsonFieldsStructured,
  questionChangedAfterRefusal,
  unboundedQuestionRulingsRefusal,
} from '../record/record-question-contract.ts'
import {
  localQuestionProjects,
  maxQuestionNumber,
  openQuestionsForCursors,
  openQuestionsForTasks,
  openStagesForSession,
  questionByNumberRow,
  questionsByIdRows,
  questionsForCursor,
  questionsForRun,
  questionsForSession,
  ruleAuditReasons,
  rulingRows,
  runInboxQuestionRows,
  taskRulingRows,
  unlinkedWorkflowQuestions,
  waitingWorkflowQuestions,
  workflowInboxQuestions,
} from './question-store-sqlite-reads.ts'
import type { QuestionReadResult, QuestionStore } from './question-store-types.ts'

const json = (value: unknown) => (value == null ? null : JSON.stringify(value))
const limited = <Row>(rows: Row[], limit?: number): Row[] =>
  limit === undefined ? rows : rows.slice(0, limit)

function assertLocalChangedAfter(input: QuestionReadInput): void {
  if (
    input.changedAfter !== undefined &&
    ((input.read !== 'rulings' && input.read !== 'inbox') ||
      (input.read === 'rulings'
        ? !/^(?:\d+|page:\d+)$/.test(input.changedAfter)
        : !/^\d+$/.test(input.changedAfter)))
  )
    throw new Error(
      `${questionChangedAfterRefusal.local.message}; ${questionChangedAfterRefusal.local.remedy}`,
    )
}

function targetedRead(database: Database, input: QuestionReadInput): QuestionReadResult | null {
  if (input.read === 'task-rulings') {
    const project = database
      .query<{ name: string }, [string]>('SELECT name FROM project WHERE record_id=?')
      .get(input.projectId)
    return {
      items: project ? taskRulingRows(database, project.name, input.taskId, input.limit ?? -1) : [],
    }
  }
  if (input.read === 'by-id')
    return { items: limited(questionsByIdRows(database, input.ids), input.limit) }
  if (input.read === 'for-run')
    return { items: limited(questionsForRun(database, input.runId), input.limit) }
  if (input.read === 'for-session')
    return { items: limited(questionsForSession(database, input.sessionId), input.limit) }
  if (input.read === 'max-number')
    return { items: limited(maxQuestionNumber(database), input.limit) }
  if (input.read === 'by-number')
    return { items: limited(questionByNumberRow(database, input.number), input.limit) }
  if (input.read === 'open-for-cursors')
    return {
      items: limited(openQuestionsForCursors(database, input.workflowCursorRecordIds), input.limit),
    }
  if (input.read === 'open-for-tasks')
    return { items: limited(openQuestionsForTasks(database, input.taskRecordIds), input.limit) }
  if (input.read === 'unlinked-workflow')
    return {
      items: limited(
        unlinkedWorkflowQuestions(database, input.project, input.workflowKey),
        input.limit,
      ),
    }
  if (input.read === 'for-cursor')
    return {
      items: limited(questionsForCursor(database, input.workflowCursorRecordId), input.limit),
    }
  if (input.read === 'rule-audit-reasons')
    return {
      items: limited(
        ruleAuditReasons(database, input.workflowCursorRecordId, input.actorSession),
        input.limit,
      ),
    }
  return null
}

function recordAppliedMutation(database: Database, input: QuestionWriteBody): void {
  database
    .query(`INSERT OR IGNORE INTO question_mutation_audit
      (record_id,question_record_id,action,actor_session,at,reason) VALUES (?,?,?,?,?,?)`)
    .run(
      input.requestId,
      input.question.id,
      input.audit.action,
      input.audit.actorSession,
      input.audit.at,
      input.audit.reason,
    )
}

export class SqliteQuestionStore implements QuestionStore {
  private readonly database: Database

  constructor(database: Database) {
    this.database = database
  }

  private readRulings(input: Extract<QuestionReadInput, { read: 'rulings' }>): QuestionReadResult {
    if (input.since === undefined && input.limit === undefined && input.changedAfter === undefined)
      throw new Error(
        `${unboundedQuestionRulingsRefusal.message}; ${unboundedQuestionRulingsRefusal.remedy}`,
      )
    const pageAfter = input.changedAfter?.startsWith('page:')
      ? Number(input.changedAfter.slice(5))
      : null
    if (input.limit !== undefined || pageAfter !== null) {
      const pageSize = input.limit ?? 100
      const all = rulingRows(this.database, {
        kind: input.kind,
        since: input.since,
        after: null,
        cursor: null,
      }).filter((row) => pageAfter === null || row.number > pageAfter)
      const items = all.slice(0, pageSize)
      const last = items.at(-1)
      return {
        items,
        ...(last ? { cursor: `page:${last.number}` } : {}),
        more: all.length > pageSize,
      }
    }
    const after = input.changedAfter === undefined ? null : Number(input.changedAfter)
    const cursor =
      after === null
        ? null
        : (this.database
            .query<{ value: number }, []>('SELECT value FROM collect_change_counter')
            .get()?.value ?? 0)
    return {
      items: limited(
        rulingRows(this.database, { kind: input.kind, since: input.since, after, cursor }),
        input.limit,
      ),
      ...(cursor === null ? {} : { cursor: String(cursor) }),
    }
  }

  private readInbox(input: Extract<QuestionReadInput, { read: 'inbox' }>): QuestionReadResult {
    const offset = input.changedAfter === undefined ? 0 : Number(input.changedAfter)
    const requested = input.limit === undefined ? undefined : input.limit + 1
    const runCount = this.database
      .query<{ count: number }, []>(
        `SELECT COUNT(*) count FROM question
         WHERE run_record_id IS NOT NULL AND answered_at IS NULL AND closed_at IS NULL`,
      )
      .get()!.count
    const runRows = runInboxQuestionRows(this.database, undefined, requested, offset)
    const workflowOffset = Math.max(0, offset - runCount)
    const workflowLimit = requested === undefined ? undefined : Math.max(0, requested - runRows.length)
    const rows = [
      ...runRows,
      ...(workflowLimit === 0
        ? []
        : workflowInboxQuestions(this.database, workflowLimit, workflowOffset)),
    ]
    const items = input.limit === undefined ? rows : rows.slice(0, input.limit)
    return {
      items,
      cursor: String(offset + items.length),
      more: input.limit !== undefined && rows.length > input.limit,
    }
  }

  async write(intent: QuestionIntent, input: QuestionWriteBody): Promise<QuestionWriteResult> {
    const q = input.question
    assertQuestionJsonFieldsStructured(q)
    const workflowStep = q.workflowCursorRecordId
      ? this.database
          .query<{ ordinal: number; step_slug: string }, [string]>(
            'SELECT ordinal,step_slug FROM workflow_cursor WHERE record_id=?',
          )
          .get(q.workflowCursorRecordId)
      : null
    const existing = this.database
      .query<{ number: number; revision: number }, [string]>(
        'SELECT number,revision FROM question WHERE record_id=?',
      )
      .get(q.id)
    if (intent !== 'ask' && !existing) throw new Error(`question ${q.id} not found`)
    const number = existing?.number ?? nextEntityNumber(this.database, 'question')
    const write = this.database
      .query(
        `INSERT INTO question
          (record_id,number,run_record_id,workflow_cursor_record_id,workflow_key,workflow_task_record_id,
           asked_at,question,options,recommendation,why,answer,answered_at,answered_by,awaiting_operator_at,
           relayed_by,asked_via,answerer_kind,answer_channel,overturned_at,overturned_by,overturn_reason,
           replacement,filed_as,filed_ref,filed_at,closed_at,close_reason,revision,filed_record_id,filed_label,
           answer_basis,answered_by_name,overturned_by_name,kind,typed_options,criteria,levels,answer_value,
           answered_by_kind,jev_pick,jev_confidence,jev_probabilities,jev_model,jev_input_tokens,jev_error,
           jev_agreed,jev_question_version,jev_fits,jev_order_flipped,workflow_step_ordinal,workflow_step_slug)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(record_id) DO UPDATE SET
           workflow_key=excluded.workflow_key,workflow_task_record_id=excluded.workflow_task_record_id,
           question=excluded.question,options=excluded.options,recommendation=excluded.recommendation,why=excluded.why,
           answer=excluded.answer,answered_at=excluded.answered_at,answered_by=excluded.answered_by,
           awaiting_operator_at=excluded.awaiting_operator_at,relayed_by=excluded.relayed_by,
           answerer_kind=excluded.answerer_kind,answer_channel=excluded.answer_channel,
           overturned_at=excluded.overturned_at,overturned_by=excluded.overturned_by,
           overturn_reason=excluded.overturn_reason,replacement=excluded.replacement,filed_as=excluded.filed_as,
           filed_ref=excluded.filed_ref,filed_at=excluded.filed_at,closed_at=excluded.closed_at,
           close_reason=excluded.close_reason,revision=excluded.revision,filed_record_id=excluded.filed_record_id,
           filed_label=excluded.filed_label,answer_basis=excluded.answer_basis,
           answered_by_name=excluded.answered_by_name,overturned_by_name=excluded.overturned_by_name,
           kind=excluded.kind,typed_options=excluded.typed_options,criteria=excluded.criteria,levels=excluded.levels,
           answer_value=excluded.answer_value,answered_by_kind=excluded.answered_by_kind,jev_pick=excluded.jev_pick,
           jev_confidence=excluded.jev_confidence,jev_probabilities=excluded.jev_probabilities,
           jev_model=excluded.jev_model,jev_input_tokens=excluded.jev_input_tokens,jev_error=excluded.jev_error,
           jev_agreed=excluded.jev_agreed,jev_question_version=excluded.jev_question_version,
           jev_fits=excluded.jev_fits,jev_order_flipped=excluded.jev_order_flipped,
           workflow_step_ordinal=COALESCE(excluded.workflow_step_ordinal,question.workflow_step_ordinal),
           workflow_step_slug=COALESCE(excluded.workflow_step_slug,question.workflow_step_slug)
         WHERE excluded.revision > question.revision`,
      )
      .run(
        q.id,
        number,
        q.runId,
        q.workflowCursorRecordId,
        q.workflowKey,
        q.workflowTaskId,
        q.askedAt,
        q.question,
        json(q.options),
        q.recommendation,
        q.why,
        q.answer,
        q.answeredAt,
        q.answeredBy,
        q.awaitingOperatorAt,
        q.relayedBy,
        q.askedVia,
        q.answererKind,
        q.answerChannel,
        q.overturnedAt,
        q.overturnedBy,
        q.overturnReason,
        q.replacement,
        q.filedAs,
        q.filedRef,
        q.filedAt,
        q.closedAt,
        q.closeReason,
        q.revision,
        q.filedRecordId,
        q.filedLabel,
        q.answerBasis,
        q.answeredByName,
        q.overturnedByName,
        q.kind ?? 'text',
        json(q.typedOptions),
        json(q.criteria),
        json(q.levels),
        q.answerValue,
        q.answeredByKind,
        q.jevPick,
        q.jevConfidence,
        json(q.jevProbabilities),
        q.jevModel,
        q.jevInputTokens,
        q.jevError,
        q.jevAgreed,
        q.jevQuestionVersion,
        q.jevFits,
        q.jevOrderFlipped,
        workflowStep === null ? null : workflowStep.ordinal + 1,
        workflowStep?.step_slug ?? null,
      )
    const applied = write.changes === 1
    if (applied) recordAppliedMutation(this.database, input)
    return { id: q.id, number, revision: Math.max(existing?.revision ?? 0, q.revision), applied }
  }

  async read(input: QuestionReadInput): Promise<QuestionReadResult> {
    assertLocalChangedAfter(input)
    if (input.read === 'inbox') return this.readInbox(input)
    if (input.read === 'waiting')
      return { items: limited(waitingWorkflowQuestions(this.database), input.limit) }
    if (input.read === 'open-for-session')
      return {
        items: limited(openStagesForSession(this.database, input.sessionId), input.limit),
      }
    if (input.read === 'rulings') return this.readRulings(input)
    const targeted = targetedRead(this.database, input)
    if (targeted) return targeted
    return { items: limited(localQuestionProjects(this.database), input.limit) }
  }
}
