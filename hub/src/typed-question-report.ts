// concern: typed-question-report
/** Reports hub-owned typed-question evidence joined to observed outcomes. */

import type { Database } from 'bun:sqlite'
import {
  type TypedQuestionAnswerRow,
  typedQuestionBlocks,
} from '../../shared/typed-question/typed-question-blocks.ts'
import type { TypedQuestionReportBlock } from '../../shared/typed-question/typed-question-render.ts'
import { db } from './db.ts'
import { noteDuplicateLabel } from './note-duplicate-question.ts'
import { TYPED_QUESTION_DECLARATIONS } from './typed-question-declarations.ts'

export function hubTypedQuestionReport(
  options: { days?: number },
  database: Database = db(),
): TypedQuestionReportBlock[] {
  const rows = database
    .query(
      `SELECT question_id,question_version,subject_kind,subject_ref,answer_json,input_tokens,latency_ms,error,model
       FROM typed_question_answer
       ${options.days === undefined ? '' : "WHERE datetime(created_at) >= datetime('now', '-' || ? || ' days')"}
       ORDER BY question_id,question_version,created_at`,
    )
    .all(...(options.days === undefined ? [] : [options.days])) as TypedQuestionAnswerRow[]
  return typedQuestionBlocks(rows, (questionId, questionVersion) => {
    const declared = TYPED_QUESTION_DECLARATIONS.find(
      (question) => question.id === questionId && question.version === questionVersion,
    )
    return {
      label: declared ? (subjectRef) => noteDuplicateLabel(database, subjectRef) : null,
      threshold: declared?.threshold ?? null,
    }
  })
}
