// concern: typed-question-report
/** Reports hub-owned typed-question evidence joined to observed outcomes. */

import type { Database } from 'bun:sqlite'
import {
  type TypedQuestionAnswerRow,
  typedQuestionBlocks,
} from '../../shared/typed-question/typed-question-blocks.ts'
import type { TypedQuestionReportBlock } from '../../shared/typed-question/typed-question-render.ts'
import { db } from './db.ts'
import { NOTE_DUPLICATE_QUESTION, noteDuplicateLabel } from './note-duplicate-question.ts'

export function hubTypedQuestionReport(
  options: { days?: number },
  database: Database = db(),
): TypedQuestionReportBlock[] {
  const rows = database
    .query(
      `SELECT question_id,question_version,subject_kind,subject_ref,answer_json,input_tokens,latency_ms,error
       FROM typed_question_answer
       ${options.days === undefined ? '' : "WHERE datetime(created_at) >= datetime('now', '-' || ? || ' days')"}
       ORDER BY question_id,question_version,created_at`,
    )
    .all(...(options.days === undefined ? [] : [options.days])) as TypedQuestionAnswerRow[]
  return typedQuestionBlocks(rows, (questionId, questionVersion) => {
    const declared = questionId === NOTE_DUPLICATE_QUESTION.id
    return {
      label: declared ? (subjectRef) => noteDuplicateLabel(database, subjectRef) : null,
      threshold:
        declared && questionVersion === NOTE_DUPLICATE_QUESTION.version
          ? NOTE_DUPLICATE_QUESTION.threshold
          : null,
    }
  })
}
