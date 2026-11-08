import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { applyQuestionAnswer } from '../run/question-answer.ts'
import { preAnswerWorkerQuestion, preAnswerWorkerQuestions } from './jev-worker-question.ts'

const choice = {
  kind: 'choice' as const,
  question: 'Which?',
  why: 'Changes the implementation.',
  options: [{ name: 'a' }, { name: 'b' }],
}

function storedQuestion(runId: string, question = choice): string {
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
      question.question,
      question.why,
      question.kind,
      question.kind === 'choice' ? JSON.stringify(question.options) : null,
      new Date().toISOString(),
    )
  return recordId
}

function batchChoice(recordId: string, a: number, b: number) {
  const answer = { choice: 'a', confidence: a, probabilities: { a, b } }
  return {
    kind: 'answer' as const,
    answers: {
      [`${recordId}:forward`]: answer,
      [`${recordId}:reversed`]: answer,
      [`${recordId}:fits`]: { noul: 1 },
    },
    model: 'jev-test',
    inputTokens: 12,
    latencyMs: 1,
  }
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
      client: async () => batchChoice(recordId, 0.95, 0.05),
      readMachine: (key) => (key === 'jev.auto_rule' ? 'on' : '0.9'),
      resolveRulings: async () => 'agent',
    })
    expect(result).toEqual({ applied: true, value: 'a' })
    expect(
      db()
        .query(
          'SELECT answer_value,jev_pick,answered_by_kind,jev_agreed,jev_question_version,jev_fits,jev_order_flipped,awaiting_operator_at,delivery_pending_at FROM question WHERE record_id=?',
        )
        .get(recordId),
    ).toEqual({
      answer_value: '"a"',
      jev_pick: '"a"',
      answered_by_kind: 'jev',
      jev_agreed: null,
      jev_question_version: 2,
      jev_fits: 1,
      jev_order_flipped: 0,
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

  test('batches two worker questions into one request and splits input tokens', async () => {
    const runId = addRun({ agent: 'codex', job: 'implement', status: 'asking', repo: 'fixture' })
    const first = storedQuestion(runId)
    const second = storedQuestion(runId)
    let calls = 0
    await preAnswerWorkerQuestions({
      runId,
      canResume: false,
      answerChannel: 'cli',
      questions: [
        { recordId: first, question: choice },
        { recordId: second, question: choice },
      ],
      client: async (questions, state) => {
        calls += 1
        expect(questions).toHaveLength(6)
        const forward = questions.find(({ id }) => id === `${first}:forward`)
        const reversed = questions.find(({ id }) => id === `${first}:reversed`)
        expect(Object.keys(forward?.criteria ?? {})).toEqual(['a', 'b'])
        expect(Object.keys(reversed?.criteria ?? {})).toEqual(['b', 'a'])
        expect(state).toMatchObject({
          worker: { why: { '1': choice.why, '2': choice.why } },
          run: { job: 'implement' },
        })
        return {
          kind: 'answer',
          answers: {
            ...batchChoice(first, 0.9, 0.1).answers,
            ...batchChoice(second, 0.8, 0.2).answers,
          },
          model: 'jev-test',
          inputTokens: 5,
          latencyMs: 1,
        }
      },
      readMachine: (key) => (key === 'jev.auto_rule' ? 'off' : '0.7'),
      resolveRulings: async () => 'agent',
    })
    expect(calls).toBe(1)
    expect(
      db()
        .query(
          'SELECT jev_question_version,jev_pick,jev_fits,jev_order_flipped,jev_input_tokens FROM question WHERE record_id IN (?,?) ORDER BY number',
        )
        .all(first, second),
    ).toEqual([
      {
        jev_question_version: 2,
        jev_pick: '"a"',
        jev_fits: 1,
        jev_order_flipped: 0,
        jev_input_tokens: 3,
      },
      {
        jev_question_version: 2,
        jev_pick: '"a"',
        jev_fits: 1,
        jev_order_flipped: 0,
        jev_input_tokens: 2,
      },
    ])
  })

  test('does not send or annotate text questions in a mixed batch', async () => {
    const runId = addRun({ agent: 'codex', job: 'implement', status: 'asking', repo: 'fixture' })
    const choiceId = storedQuestion(runId)
    const text = { kind: 'text' as const, question: 'Explain?', why: 'Need details.' }
    const textId = storedQuestion(runId, text)
    await preAnswerWorkerQuestions({
      runId,
      canResume: false,
      answerChannel: 'cli',
      questions: [
        { recordId: choiceId, question: choice },
        { recordId: textId, question: text },
      ],
      client: async (questions) => {
        expect(questions).toHaveLength(3)
        expect(questions.every(({ id }) => id.startsWith(choiceId))).toBe(true)
        return batchChoice(choiceId, 0.9, 0.1)
      },
      readMachine: (key) => (key === 'jev.auto_rule' ? 'off' : '0.7'),
      resolveRulings: async () => 'agent',
    })
    expect(
      db()
        .query(
          'SELECT jev_question_version,jev_pick,jev_model,jev_input_tokens,jev_error FROM question WHERE record_id=?',
        )
        .get(textId),
    ).toEqual({
      jev_question_version: null,
      jev_pick: null,
      jev_model: null,
      jev_input_tokens: null,
      jev_error: null,
    })
  })

  test('a missing run does not throw and records an error when the question is addressable', async () => {
    const actualRunId = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'asking',
      repo: 'fixture',
    })
    const recordId = storedQuestion(actualRunId)
    const missingRunId = newRecordId()
    await expect(
      preAnswerWorkerQuestions({
        runId: missingRunId,
        canResume: false,
        answerChannel: 'cli',
        questions: [{ recordId, question: choice }],
      }),
    ).resolves.toEqual([{ applied: false }])
    expect(db().query('SELECT jev_error FROM question WHERE record_id=?').get(recordId)).toEqual({
      jev_error: `run ${missingRunId} was not found while preparing Jev advice`,
    })
  })

  test('stores partial choice advice and names a dropped fit answer', async () => {
    const runId = addRun({ agent: 'codex', job: 'implement', status: 'asking', repo: 'fixture' })
    const recordId = storedQuestion(runId)
    const response = batchChoice(recordId, 0.9, 0.1)
    delete response.answers[`${recordId}:fits`]
    const result = await preAnswerWorkerQuestion({
      recordId,
      runId,
      question: choice,
      canResume: true,
      answerChannel: 'mcp',
      client: async () => response,
      readMachine: (key) => (key === 'jev.auto_rule' ? 'on' : '0.7'),
      resolveRulings: async () => 'agent',
    })
    expect(result).toEqual({ applied: false })
    expect(
      db()
        .query('SELECT jev_pick,jev_fits,jev_error,answered_at FROM question WHERE record_id=?')
        .get(recordId),
    ).toEqual({
      jev_pick: '"a"',
      jev_fits: null,
      jev_error: `Jev response omitted expected answer ids: ${recordId}:fits`,
      answered_at: null,
    })
  })

  test('reads root spec state and omits a missing prompt file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jev-state-'))
    try {
      const prompt = join(directory, 'prompt.txt')
      writeFileSync(prompt, 'root specification')
      const runId = addRun({ agent: 'codex', job: 'implement', status: 'asking', repo: 'fixture' })
      db().query('UPDATE run SET prompt_path=? WHERE record_id=?').run(prompt, runId)
      const recordId = storedQuestion(runId)
      let seen: unknown
      await preAnswerWorkerQuestion({
        recordId,
        runId,
        question: choice,
        canResume: false,
        answerChannel: 'cli',
        client: async (_questions, state) => {
          seen = state
          return batchChoice(recordId, 0.9, 0.1)
        },
        readMachine: (key) => (key === 'jev.auto_rule' ? 'off' : '0.7'),
        resolveRulings: async () => 'agent',
      })
      expect(seen).toMatchObject({ spec: 'root specification' })
      db()
        .query('UPDATE run SET prompt_path=? WHERE record_id=?')
        .run(join(directory, 'missing'), runId)
      await preAnswerWorkerQuestion({
        recordId,
        runId,
        question: choice,
        canResume: false,
        answerChannel: 'cli',
        client: async (_questions, state) => {
          seen = state
          return batchChoice(recordId, 0.9, 0.1)
        },
        readMachine: (key) => (key === 'jev.auto_rule' ? 'off' : '0.7'),
        resolveRulings: async () => 'agent',
      })
      expect(seen).not.toHaveProperty('spec')
    } finally {
      rmSync(directory, { recursive: true })
    }
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
        return batchChoice(recordId, 0.95, 0.05)
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
      client: async () => batchChoice(recordId, 1, 0),
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
      client: async () => batchChoice(recordId, 1, 0),
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
