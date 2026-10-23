import { describe, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import {
  type AnswerIdentifierFacts,
  answerIdentifierDecision,
  parseAnswerIdentifier,
  resolveAnswerIdentifier,
} from './run-answer-identifier.ts'

const run = (overrides: Partial<NonNullable<AnswerIdentifierFacts['run']>> = {}) => ({
  recordId: 'asking-run',
  rootRecordId: 'asking-run',
  status: 'asking',
  ownedByCaller: true,
  openQuestionNumbers: [14],
  ...overrides,
})

const question = (overrides: Partial<NonNullable<AnswerIdentifierFacts['question']>> = {}) => ({
  rootRecordId: 'question-root',
  open: true,
  state: 'open' as const,
  openQuestionNumbers: [12],
  ...overrides,
})

describe('answer identifier parse', () => {
  test('owns q-prefix grammar and accepts the run identifier forms', () => {
    const recordId = newRecordId()
    expect(parseAnswerIdentifier('q42')).toEqual({ kind: 'question-number', number: 42 })
    expect(parseAnswerIdentifier('42')).toEqual({ kind: 'run-number', number: 42 })
    expect(parseAnswerIdentifier(recordId.toUpperCase())).toEqual({
      kind: 'record-id',
      recordId,
    })
    expect(() => parseAnswerIdentifier('q0')).toThrow('invalid answer identifier')
  })
})

describe('answer identifier decision', () => {
  test('refuses an answered or closed question and names the chain current wait', () => {
    expect(
      answerIdentifierDecision({
        identifier: { kind: 'question-number', number: 12 },
        run: null,
        question: question({ open: false, state: 'ruled', openQuestionNumbers: [14] }),
      }),
    ).toEqual({
      kind: 'refuse',
      reason: 'q12 is already ruled on; run question-root is waiting on q14',
    })
    expect(
      answerIdentifierDecision({
        identifier: { kind: 'question-number', number: 12 },
        run: null,
        question: question({ open: false, state: 'closed', openQuestionNumbers: [] }),
      }),
    ).toEqual({
      kind: 'refuse',
      reason: 'q12 is closed; run question-root has no open questions',
    })
  })

  test('treats any different-chain question collision as ambiguous', () => {
    expect(
      answerIdentifierDecision({
        identifier: { kind: 'run-number', number: 12 },
        run: run(),
        question: question({ open: false, state: 'ruled', openQuestionNumbers: [] }),
      }),
    ).toEqual({
      kind: 'refuse',
      reason:
        'bare identifier 12 is ambiguous between run:12 (asking-run) and q12; pass the run UUID or q12',
    })
  })

  test('does not call a same-chain collision ambiguous', () => {
    expect(
      answerIdentifierDecision({
        identifier: { kind: 'run-number', number: 12 },
        run: run(),
        question: question({ rootRecordId: 'asking-run', open: false, state: 'ruled' }),
      }),
    ).toEqual({ kind: 'target', runRecordId: 'asking-run' })
  })

  test('distinguishes no open question, foreign ownership, and non-asking status', () => {
    expect(
      answerIdentifierDecision({
        identifier: { kind: 'run-number', number: 12 },
        run: run({ status: 'ok', openQuestionNumbers: [] }),
        question: null,
      }),
    ).toEqual({
      kind: 'refuse',
      reason: 'run 12 has no open question (status: ok); to answer question q12, pass q12',
    })
    expect(
      answerIdentifierDecision({
        identifier: { kind: 'run-number', number: 12 },
        run: run({ ownedByCaller: false, openQuestionNumbers: [14, 15] }),
        question: null,
      }),
    ).toEqual({
      kind: 'refuse',
      reason:
        'run 12 has open questions but they are not owned by the current session; answer them explicitly with q14, q15',
    })
    expect(
      answerIdentifierDecision({
        identifier: { kind: 'run-number', number: 12 },
        run: run({ status: 'running' }),
        question: null,
      }),
    ).toEqual({
      kind: 'refuse',
      reason: 'run 12 is not asking (status: running); answer it explicitly with q14',
    })
  })
})

function addQuestion(runRecordId: string, number: number, recordId = newRecordId()): string {
  db()
    .query(
      `INSERT INTO question (record_id,number,run_record_id,asked_at,question)
       VALUES (?,?,?,'2026-10-14','Which?')`,
    )
    .run(recordId, number, runRecordId)
  return recordId
}

test('question number and UUID resolve an open question asked by a real turn to its root', () => {
  const root = addRun({ agent: 'codex', job: 'file-question', status: 'asking' })
  const turn = addRun({
    agent: 'codex',
    job: 'file-question',
    status: 'asking',
    parent: root,
    turn: 2,
  })
  const questionId = addQuestion(turn, 73)

  expect(resolveAnswerIdentifier(db(), 'q73', null)).toBe(root)
  expect(resolveAnswerIdentifier(db(), questionId, null)).toBe(root)
})

test('an answered question target refuses instead of selecting another open question', () => {
  const root = addRun({ agent: 'codex', job: 'file-question', status: 'asking' })
  const answeredId = addQuestion(root, 81)
  addQuestion(root, 82)
  db()
    .query("UPDATE question SET answered_at='2026-10-15',answer='yes' WHERE record_id=?")
    .run(answeredId)

  expect(() => resolveAnswerIdentifier(db(), 'q81', null)).toThrow(
    `q81 is already ruled on; run ${root} is waiting on q82`,
  )
  expect(() => resolveAnswerIdentifier(db(), answeredId, null)).toThrow(
    `${answeredId} is already ruled on; run ${root} is waiting on q82`,
  )
})

test('bare-number resolution uses real run, question, ownership, and chain facts', () => {
  const session = 'answer-session'
  const asking = addRun({ agent: 'codex', job: 'file-question', status: 'asking', session })
  const other = addRun({ agent: 'codex', job: 'file-question', status: 'asking', session })
  const runNumber = db()
    .query<{ number: number }, [string]>('SELECT number FROM run WHERE record_id=?')
    .get(asking)!.number
  const collidingQuestion = addQuestion(other, runNumber)
  db()
    .query("UPDATE question SET answered_at='2026-10-15',answer='done' WHERE record_id=?")
    .run(collidingQuestion)
  addQuestion(asking, runNumber + 1000)

  expect(() => resolveAnswerIdentifier(db(), runNumber, session)).toThrow(
    `bare identifier ${runNumber} is ambiguous between run:${runNumber} (${asking}) and q${runNumber}`,
  )
  expect(resolveAnswerIdentifier(db(), asking, session)).toBe(asking)
})
