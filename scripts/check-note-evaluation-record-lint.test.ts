import { expect, test } from 'bun:test'
import {
  hostileNoteEvaluationRecord,
  noteEvaluationRecordLintFindings,
} from './check-note-evaluation-record-lint.ts'

test('a full note evaluation record is accepted by the stored-document lint', () => {
  expect(hostileNoteEvaluationRecord().match(/```note-evaluation-json/g)).toHaveLength(1)
  expect(noteEvaluationRecordLintFindings()).toEqual([])
})
