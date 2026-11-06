import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { applyQuestionAnswer } from '../run/question-answer.ts'
import { answeredQuestion, type TypedAnswerQuestion } from '../run/run-answer-typed-value.ts'
import { applyMigrations } from './migrations.ts'
import { fixtureProjectRecordId, migrationBoundaryTestDatabase } from './test-database.fixture.ts'

const MIGRATION = '0208_worker_question_jev'

test('legacy choice questions are backfilled once and remain answerable', () => {
  const database = migrationBoundaryTestDatabase(MIGRATION)
  try {
    const runId = newRecordId()
    const questionId = newRecordId()
    database
      .query(
        `INSERT INTO run
         (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,repo,cwd,project_record_id)
         VALUES (?,1,?,'codex','implement','x',1,'x','asking','fixture',?,?)`,
      )
      .run(runId, new Date().toISOString(), process.cwd(), fixtureProjectRecordId(database))
    database
      .query(
        `INSERT INTO question
         (number,record_id,run_record_id,asked_at,question,options)
         VALUES (1,?,?,?,?,?)`,
      )
      .run(
        questionId,
        runId,
        new Date().toISOString(),
        'Which?',
        JSON.stringify(['existing', 'new']),
      )

    expect(applyMigrations(database)).toContain(MIGRATION)
    const stored = database
      .query(
        'SELECT record_id,number,question,why,kind,options,typed_options,criteria,levels FROM question WHERE record_id=?',
      )
      .get(questionId) as TypedAnswerQuestion
    const answer = answeredQuestion(stored, 'new', true)
    applyQuestionAnswer({
      database,
      questionId,
      answer: answer.answer,
      value: answer.typedValue,
      answeredAt: new Date().toISOString(),
      answeredBy: 'architect',
      answeredByName: null,
      answeredByKind: 'architect',
      answererKind: 'operator',
      channel: 'cli',
      deliveryPendingAt: null,
    })
    expect(
      database
        .query(
          'SELECT kind,typed_options,answer,answer_value,change_seq FROM question WHERE record_id=?',
        )
        .get(questionId),
    ).toMatchObject({
      kind: 'choice',
      typed_options: '[{"name":"existing"},{"name":"new"}]',
      answer: 'new',
      answer_value: '"new"',
    })
    const sequence = (
      database.query('SELECT change_seq FROM question WHERE record_id=?').get(questionId) as {
        change_seq: number
      }
    ).change_seq
    expect(applyMigrations(database)).toEqual([])
    expect(
      database.query('SELECT change_seq FROM question WHERE record_id=?').get(questionId),
    ).toEqual({ change_seq: sequence })
  } finally {
    database.close()
  }
})
