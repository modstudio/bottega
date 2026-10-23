import { describe, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import {
  answerIdentifierDecision,
  parseQuestionIdentifier,
  resolveAnswerIdentifier,
  resolveQuestionIdentifier,
} from './question-identifier.ts'

describe('question identifier', () => {
  test('parses numbers and UUIDs and resolves either form to one row', () => {
    const runId = addRun({ agent: 'codex', job: 'file-question', status: 'asking' })
    const recordId = newRecordId()
    const { number } = db()
      .query<{ number: number }, [string, string]>(
        "INSERT INTO question (record_id,number,run_record_id,asked_at,question) VALUES (?,1,?,'2026-10-14','Which?') RETURNING number",
      )
      .get(recordId, runId)!
    expect(parseQuestionIdentifier(String(number))).toEqual({ kind: 'number', id: number })
    expect(parseQuestionIdentifier(recordId.toUpperCase())).toEqual({
      kind: 'record-id',
      recordId,
    })
    expect(resolveQuestionIdentifier(db(), number)).toBe(recordId)
    expect(resolveQuestionIdentifier(db(), recordId)).toBe(recordId)
  })
})

describe('answer identifier decision', () => {
  const ownedOpenQuestion = {
    rootRecordId: 'question-root',
    open: true,
    ownedByCaller: true,
  }
  const askingRun = {
    recordId: 'asking-run',
    status: 'asking',
    hasOpenQuestionOwnedByCaller: true,
  }

  test('q<number> targets the question own chain', () => {
    expect(
      answerIdentifierDecision({
        identifier: { kind: 'question-number', number: 42 },
        run: null,
        question: ownedOpenQuestion,
      }),
    ).toEqual({ kind: 'target', runRecordId: 'question-root' })
  })

  test('a bare decimal targets only an asking run with an owned open question', () => {
    expect(
      answerIdentifierDecision({
        identifier: { kind: 'run-number', number: 42 },
        run: askingRun,
        question: null,
      }),
    ).toEqual({ kind: 'target', runRecordId: 'asking-run' })

    expect(
      answerIdentifierDecision({
        identifier: { kind: 'run-number', number: 42 },
        run: { ...askingRun, status: 'ok' },
        question: ownedOpenQuestion,
      }),
    ).toEqual({
      kind: 'refuse',
      reason: 'run 42 has no open question (status: ok); to answer question q42, pass q42',
    })
  })

  test('a bare decimal refuses an asking-run and open-question collision', () => {
    expect(
      answerIdentifierDecision({
        identifier: { kind: 'run-number', number: 42 },
        run: askingRun,
        question: ownedOpenQuestion,
      }),
    ).toEqual({
      kind: 'refuse',
      reason:
        'bare identifier 42 is ambiguous between run:42 (asking-run) and q42; pass the run UUID or q42',
    })
  })

  test('full run UUIDs keep targeting the run directly', () => {
    expect(
      answerIdentifierDecision({
        identifier: { kind: 'run-record-id', recordId: 'run-uuid' },
        run: askingRun,
        question: null,
      }),
    ).toEqual({ kind: 'target', runRecordId: 'asking-run' })
  })
})

test('answer identifier resolution gathers run and question facts without crossing chains', () => {
  const session = 'answer-session'
  const asking = addRun({ agent: 'codex', job: 'file-question', status: 'asking', session })
  const other = addRun({ agent: 'codex', job: 'file-question', status: 'asking', session })
  const runNumber = db()
    .query<{ number: number }, [string]>('SELECT number FROM run WHERE record_id=?')
    .get(asking)!.number
  const questionRecordId = newRecordId()
  db()
    .query(
      `INSERT INTO question (record_id,number,run_record_id,asked_at,question)
       VALUES (?,(SELECT number FROM run WHERE record_id=?),?,'2026-10-14','Which?')`,
    )
    .run(questionRecordId, asking, other)
  db()
    .query(
      `INSERT INTO question (record_id,number,run_record_id,asked_at,question)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM question),?,'2026-10-14','Owned?')`,
    )
    .run(newRecordId(), asking)

  expect(() => resolveAnswerIdentifier(db(), runNumber, session)).toThrow(
    `bare identifier ${runNumber} is ambiguous between run:${runNumber} (${asking}) and q${runNumber}`,
  )
  expect(resolveAnswerIdentifier(db(), `q${runNumber}`, session)).toBe(other)
  expect(resolveAnswerIdentifier(db(), asking, session)).toBe(asking)
})
