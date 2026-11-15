// concern: sqlite-question-store
/** Adapts the existing SQLite question rows to the question port. */

import type { Database } from 'bun:sqlite'
import type {
  QuestionIntent,
  QuestionReadInput,
  QuestionWriteBody,
  QuestionWriteResult,
} from '../record/record-question-contract.ts'
import { questionChangedAfterRefusal } from '../record/record-question-contract.ts'
import { runInboxQuestionRows } from '../run/run-inbox.ts'
import {
  localQuestionProjects,
  openStagesForSession,
  rulingRows,
  taskRulingRows,
  waitingWorkflowQuestions,
  workflowInboxQuestions,
} from '../workflow/task-flow-store-sqlite-questions.ts'
import type { QuestionReadResult, QuestionStore } from './question-store-types.ts'

const json = (value: unknown) => (value == null ? null : JSON.stringify(value))
const limited = <Row>(rows: Row[], limit?: number): Row[] =>
  limit === undefined ? rows : rows.slice(0, limit)

export class SqliteQuestionStore implements QuestionStore {
  private readonly database: Database

  constructor(database: Database) {
    this.database = database
  }

  async write(intent: QuestionIntent, input: QuestionWriteBody): Promise<QuestionWriteResult> {
    const q = input.question
    const existing = this.database
      .query<{ number: number; revision: number }, [string]>(
        'SELECT number,revision FROM question WHERE record_id=?',
      )
      .get(q.id)
    if (intent !== 'ask' && !existing) throw new Error(`question ${q.id} not found`)
    const number =
      existing?.number ??
      this.database
        .query<{ number: number }, []>('SELECT COALESCE(MAX(number),0)+1 number FROM question')
        .get()!.number
    this.database
      .query(
        `INSERT INTO question
          (record_id,number,run_record_id,workflow_cursor_record_id,workflow_key,workflow_task_record_id,
           asked_at,question,options,recommendation,why,answer,answered_at,answered_by,awaiting_operator_at,
           relayed_by,asked_via,answerer_kind,answer_channel,overturned_at,overturned_by,overturn_reason,
           replacement,filed_as,filed_ref,filed_at,closed_at,close_reason,revision,filed_record_id,filed_label,
           answer_basis,answered_by_name,overturned_by_name,kind,typed_options,criteria,levels,answer_value,
           answered_by_kind,jev_pick,jev_confidence,jev_probabilities,jev_model,jev_input_tokens,jev_error,
           jev_agreed,jev_question_version,jev_fits,jev_order_flipped)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
           jev_fits=excluded.jev_fits,jev_order_flipped=excluded.jev_order_flipped
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
      )
    this.database
      .query(`INSERT OR IGNORE INTO question_mutation_audit
        (record_id,question_record_id,action,actor_session,at,reason) VALUES (?,?,?,?,?,?)`)
      .run(
        input.requestId,
        q.id,
        input.audit.action,
        input.audit.actorSession,
        input.audit.at,
        input.audit.reason,
      )
    return { id: q.id, number, revision: Math.max(existing?.revision ?? 0, q.revision) }
  }

  async read(input: QuestionReadInput): Promise<QuestionReadResult> {
    if (input.changedAfter !== undefined)
      throw new Error(
        `${questionChangedAfterRefusal.message}; ${questionChangedAfterRefusal.remedy}`,
      )
    if (input.read === 'inbox')
      return {
        items: limited(
          [...runInboxQuestionRows(this.database), ...workflowInboxQuestions(this.database)],
          input.limit,
        ),
      }
    if (input.read === 'waiting')
      return { items: limited(waitingWorkflowQuestions(this.database), input.limit) }
    if (input.read === 'open-for-session')
      return {
        items: limited(openStagesForSession(this.database, input.sessionId), input.limit),
      }
    if (input.read === 'rulings')
      return {
        items: limited(
          rulingRows(this.database, {
            kind: input.kind,
            since: input.since,
            after: null,
            cursor: null,
          }) as QuestionReadResult['items'],
          input.limit,
        ),
      }
    if (input.read === 'task-rulings') {
      const project = this.database
        .query<{ name: string }, [string]>('SELECT name FROM project WHERE record_id=?')
        .get(input.projectId)
      return {
        items: project
          ? taskRulingRows(this.database, project.name, input.taskId, input.limit ?? -1)
          : [],
      }
    }
    return { items: limited(localQuestionProjects(this.database), input.limit) }
  }
}
