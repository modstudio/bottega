import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { applyQuestionAnswer } from '../run/question-answer.ts'
import { preAnswerWorkerQuestion } from './jev-worker-question.ts'

const choice = {
  kind: 'choice' as const,
  question: 'Which?',
  why: 'Changes the implementation.',
  options: [{ name: 'a' }, { name: 'b' }],
}

function storedQuestion(runId: string): string {
  const recordId = newRecordId()
  db()
    .query(
      `INSERT INTO question
       (number,record_id,run_record_id,asked_at,question,why,kind,typed_options,awaiting_operator_at)
       VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),?,?,?,?,?,?,?,?)`,
    )
    .run(
      recordId,
      runId,
      new Date().toISOString(),
      choice.question,
      choice.why,
      choice.kind,
      JSON.stringify(choice.options),
      new Date().toISOString(),
    )
  return recordId
}

describe('Jev worker-question apply path', () => {
  test('applies through the durable answer transition', async () => {
    const runId = addRun({ agent: 'codex', job: 'implement', status: 'asking', repo: 'fixture' })
    const recordId = storedQuestion(runId)
    const result = await preAnswerWorkerQuestion({
      recordId,
      runId,
      question: choice,
      canResume: true,
      answerChannel: 'mcp',
      client: async () => ({
        kind: 'answer',
        answer: { choice: 'a', confidence: 0.95, probabilities: { a: 0.95, b: 0.05 } },
        model: 'jev-test',
        inputTokens: 12,
        latencyMs: 1,
      }),
      readMachine: (key) => (key === 'jev.auto_rule' ? 'on' : '0.9'),
      resolveRulings: async () => 'agent',
    })
    expect(result).toEqual({ applied: true, value: 'a' })
    expect(
      db()
        .query(
          'SELECT answer_value,jev_pick,answered_by_kind,jev_agreed,awaiting_operator_at,delivery_pending_at FROM question WHERE record_id=?',
        )
        .get(recordId),
    ).toEqual({
      answer_value: '"a"',
      jev_pick: '"a"',
      answered_by_kind: 'jev',
      jev_agreed: null,
      awaiting_operator_at: null,
      delivery_pending_at: null,
    })
    expect(db().query('SELECT count(*) count FROM outbox WHERE row_id=?').get(recordId)).toEqual({
      count: 1,
    })
    expect(
      db().query("SELECT count(*) count FROM run_mutation_audit WHERE action='answer'").get(),
    ).toEqual({ count: 1 })
    expect(
      db()
        .query('SELECT mode,outcome FROM question_delivery WHERE question_record_id=? ORDER BY at')
        .all(recordId),
    ).toEqual([{ mode: 'live', outcome: 'delivered' }])

    const architectQuestion = storedQuestion(runId)
    db().query('UPDATE question SET jev_pick=? WHERE record_id=?').run('"a"', architectQuestion)
    expect(
      applyQuestionAnswer({
        database: db(),
        questionId: architectQuestion,
        answer: 'a',
        value: 'a',
        answeredAt: new Date().toISOString(),
        answeredBy: 'architect',
        answeredByName: null,
        answeredByKind: 'architect',
        answererKind: 'operator',
        channel: 'cli',
        deliveryPendingAt: null,
      }),
    ).toBe(true)
    expect(
      db().query('SELECT jev_agreed FROM question WHERE record_id=?').get(architectQuestion),
    ).toEqual({ jev_agreed: 1 })
  })

  test('an architect answer that wins the race is not overwritten', async () => {
    const runId = addRun({ agent: 'codex', job: 'implement', status: 'asking', repo: 'fixture' })
    const recordId = storedQuestion(runId)
    const result = await preAnswerWorkerQuestion({
      recordId,
      runId,
      question: choice,
      canResume: true,
      answerChannel: 'mcp',
      client: async () => {
        expect(
          applyQuestionAnswer({
            database: db(),
            questionId: recordId,
            answer: 'b',
            value: 'b',
            answeredAt: new Date().toISOString(),
            answeredBy: 'architect',
            answeredByName: null,
            answeredByKind: 'architect',
            answererKind: 'operator',
            channel: 'mcp',
            deliveryPendingAt: null,
          }),
        ).toBe(true)
        return {
          kind: 'answer',
          answer: { choice: 'a', confidence: 0.95, probabilities: { a: 0.95, b: 0.05 } },
          model: 'jev-test',
          inputTokens: 12,
          latencyMs: 1,
        }
      },
      readMachine: (key) => (key === 'jev.auto_rule' ? 'on' : '0.9'),
      resolveRulings: async () => 'agent',
    })
    expect(result).toEqual({ applied: false })
    expect(
      db()
        .query(
          'SELECT answer,answer_value,answered_by_kind,jev_pick,jev_error FROM question WHERE record_id=?',
        )
        .get(recordId),
    ).toEqual({
      answer: 'b',
      answer_value: '"b"',
      answered_by_kind: 'architect',
      jev_pick: '"a"',
      jev_error: 'question was answered or closed while Jev was deciding',
    })
    expect(
      db()
        .query('SELECT count(*) count FROM question_delivery WHERE question_record_id=?')
        .get(recordId),
    ).toEqual({ count: 0 })
    expect(
      db().query("SELECT count(*) count FROM run_mutation_audit WHERE action='answer'").get(),
    ).toEqual({ count: 0 })
  })

  test('an invalid threshold escalates and records its remedy', async () => {
    const runId = addRun({ agent: 'codex', job: 'implement', status: 'asking', repo: 'fixture' })
    const recordId = storedQuestion(runId)
    const result = await preAnswerWorkerQuestion({
      recordId,
      runId,
      question: choice,
      canResume: true,
      answerChannel: 'mcp',
      client: async () => ({
        kind: 'answer',
        answer: { choice: 'a', confidence: 1, probabilities: { a: 1, b: 0 } },
        model: 'jev-test',
        inputTokens: 0,
        latencyMs: 1,
      }),
      readMachine: (key) => (key === 'jev.confidence_threshold' ? 'NaN' : 'on'),
      resolveRulings: async () => 'agent',
    })
    expect(result).toEqual({ applied: false })
    expect(
      (
        db().query('SELECT jev_error FROM question WHERE record_id=?').get(recordId) as {
          jev_error: string
        }
      ).jev_error,
    ).toContain(`${PLATFORM_SLUG} machine config set jev.confidence_threshold`)
  })

  test('a rulings resolver failure is recorded and escalates', async () => {
    const runId = addRun({ agent: 'codex', job: 'implement', status: 'asking', repo: 'fixture' })
    const recordId = storedQuestion(runId)
    const result = await preAnswerWorkerQuestion({
      recordId,
      runId,
      question: choice,
      canResume: true,
      answerChannel: 'mcp',
      client: async () => ({
        kind: 'answer',
        answer: { choice: 'a', confidence: 1, probabilities: { a: 1, b: 0 } },
        model: 'jev-test',
        inputTokens: 0,
        latencyMs: 1,
      }),
      readMachine: (key) => (key === 'jev.auto_rule' ? 'on' : '0.9'),
      resolveRulings: async () => {
        throw new Error('rulings unavailable')
      },
    })
    expect(result).toEqual({ applied: false })
    expect(db().query('SELECT jev_error FROM question WHERE record_id=?').get(recordId)).toEqual({
      jev_error: 'Error: rulings unavailable',
    })
    expect(db().query('SELECT count(*) count FROM outbox WHERE row_id=?').get(recordId)).toEqual({
      count: 1,
    })
  })
})
