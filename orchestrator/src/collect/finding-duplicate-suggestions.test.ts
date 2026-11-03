import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
import { parseDuplicateFinding } from '../review/review-duplicate-link.ts'
import { FINDING_DUPLICATE_QUESTION } from '../typed-question/finding-duplicate-question.ts'
import {
  type DuplicateFindingRow,
  duplicateSuggestionLine,
  recordedAnswers,
  selectFindingDuplicatePairs,
  suggestionLines,
  unansweredFindingDuplicatePairs,
} from './finding-duplicate-suggestions.ts'

function finding(
  input: Partial<DuplicateFindingRow> & { findingRecordId: string },
): DuplicateFindingRow {
  return {
    findingRecordId: input.findingRecordId,
    runRecordId: input.runRecordId ?? 'current-run',
    runNumber: input.runNumber ?? 10,
    job: input.job ?? 'review-lens',
    reviewRecordId: input.reviewRecordId ?? 'review-a',
    reviewedTip: input.reviewedTip ?? 'tip-a',
    ordinal: input.ordinal ?? 1,
    location: input.location ?? 'file.ts:1',
    severity: input.severity ?? 'high',
    evidence: input.evidence ?? 'evidence',
    proposedCorrection: input.proposedCorrection ?? 'fix it',
  }
}

test('selects only other findings runs on the same review or tip and excludes an answered state', () => {
  const current = finding({ findingRecordId: '000-current' })
  const sameReview = finding({
    findingRecordId: '100-review',
    runRecordId: 'review-run',
    runNumber: 11,
  })
  const sameTip = finding({
    findingRecordId: '200-tip',
    runRecordId: 'tip-run',
    runNumber: 12,
    reviewRecordId: 'review-b',
  })
  const unrelated = finding({
    findingRecordId: '300-other',
    runRecordId: 'other-run',
    reviewRecordId: 'review-c',
    reviewedTip: 'tip-c',
  })
  const nonFindings = finding({
    findingRecordId: '400-implement',
    runRecordId: 'implement-run',
    job: 'implement',
  })
  const rows = [current, sameReview, sameTip, unrelated, nonFindings]
  const first = selectFindingDuplicatePairs('current-run', rows, new Map())
  expect(first.map((pair) => pair.other.findingRecordId)).toEqual(['100-review', '200-tip'])

  const answered = new Map([[`${first[0]!.subjectRef}\0${first[0]!.stateSha}`, '{"noul":0.7}']])
  const selected = selectFindingDuplicatePairs('current-run', rows, answered)
  expect(selected[0]!.recordedAnswerJson).toBe('{"noul":0.7}')
  expect(selected[1]!.recordedAnswerJson).toBeUndefined()
  expect(
    unansweredFindingDuplicatePairs(selected).map((pair) => pair.other.findingRecordId),
  ).toEqual(['200-tip'])
  expect(selected[0]!.state.findings[0]).toEqual({
    location: 'file.ts:1',
    severity: 'high',
    evidence: 'evidence',
    proposed_correction: 'fix it',
  })
})

test('renders a duplicate flag that the score parser accepts', () => {
  const pair = selectFindingDuplicatePairs(
    'current-run',
    [
      finding({ findingRecordId: '000-current', ordinal: 2, runNumber: 10 }),
      finding({
        findingRecordId: '100-other',
        runRecordId: 'other-run',
        ordinal: 3,
        runNumber: 42,
      }),
    ],
    new Map(),
  )[0]!
  const line = duplicateSuggestionLine(pair, 0.934)
  const flag = line.match(/--duplicate (\S+)/)![1]!
  expect(flag).toBe('2=42#3')
  expect(parseDuplicateFinding(flag)).toEqual({ ordinal: 2, otherRunId: '42', otherOrdinal: 3 })
})

test("reads only this run's pairs, and asks again after a recorded error", () => {
  const insert = (subject: string, answer: string | null, error: string | null) =>
    db()
      .query(
        `INSERT INTO typed_question_answer
         (record_id,question_id,question_version,subject_kind,subject_ref,state_sha,answer_json,
          model,input_tokens,latency_ms,error,created_at)
         VALUES (?,?,?,'finding-pair',?,'state',?,'jev',1,1,?,?)`,
      )
      .run(
        newRecordId(),
        FINDING_DUPLICATE_QUESTION.id,
        FINDING_DUPLICATE_QUESTION.version,
        subject,
        answer,
        error,
        new Date().toISOString(),
      )
  insert('f1:f2', JSON.stringify({ noul: 0.9 }), null)
  insert('f1:f3', null, 'timeout')
  insert('f8:f9', JSON.stringify({ noul: 0.9 }), null)
  const recorded = recordedAnswers(db(), ['f1'])
  expect(recorded.get('f1:f2\0state')).toBe(JSON.stringify({ noul: 0.9 }))
  expect(recorded.has('f1:f3\0state')).toBeFalse()
  expect(recorded.has('f8:f9\0state')).toBeFalse()
})

test('drops only the pairs without a probability and keeps the rest', () => {
  const pairs = selectFindingDuplicatePairs(
    'current-run',
    [
      finding({ findingRecordId: '000-current', ordinal: 1, runNumber: 10 }),
      finding({ findingRecordId: '100-a', runRecordId: 'run-a', ordinal: 2, runNumber: 41 }),
      finding({ findingRecordId: '200-b', runRecordId: 'run-b', ordinal: 3, runNumber: 42 }),
      finding({ findingRecordId: '300-c', runRecordId: 'run-c', ordinal: 4, runNumber: 43 }),
    ],
    new Map(),
  )
  const lines = suggestionLines(pairs, [null, 0.95, 0.5])
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('42#3')
})
