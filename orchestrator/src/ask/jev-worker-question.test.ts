import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
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
          'SELECT answer_value,jev_pick,answered_by_kind,awaiting_operator_at FROM question WHERE record_id=?',
        )
        .get(recordId),
    ).toEqual({
      answer_value: '"a"',
      jev_pick: '"a"',
      answered_by_kind: 'jev',
      awaiting_operator_at: null,
    })
    expect(db().query('SELECT count(*) count FROM outbox WHERE row_id=?').get(recordId)).toEqual({
      count: 1,
    })
    expect(
      db().query("SELECT count(*) count FROM run_mutation_audit WHERE action='answer'").get(),
    ).toEqual({ count: 1 })
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
})
