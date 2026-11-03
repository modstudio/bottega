import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
import { fixtureProjectRecordId } from '../database/test-database.fixture.ts'
import { SPEC_UNSETTLED_QUESTION } from './spec-unsettled-question.ts'
import { specUnsettledLabel, typedQuestionReport } from './typed-question-report.ts'

function run(input: { spec: string; status: string; job?: string; parent?: string }): string {
  const database = db()
  const recordId = newRecordId()
  database
    .query(
      `INSERT INTO run
       (record_id,number,started_at,agent,job,prompt_sha,spec_sha,prompt_bytes,prompt_head,status,
        turn,project_record_id,parent_run_record_id)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM run),?,'codex',?,'prompt',?,1,'prompt',?,
               ?,?,?)`,
    )
    .run(
      recordId,
      new Date().toISOString(),
      input.job ?? 'implement',
      input.spec,
      input.status,
      input.parent ? 2 : 1,
      fixtureProjectRecordId(database),
      input.parent ?? null,
    )
  return recordId
}

function ask(runRecordId: string): void {
  db()
    .query(
      `INSERT INTO question (number,record_id,run_record_id,asked_at,question)
       VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),?,?,?,'fixture question')`,
    )
    .run(newRecordId(), runRecordId, new Date().toISOString())
}

test('labels a question asked on the implement root positive', () => {
  const root = run({ spec: 'asked-root', status: 'ok' })
  ask(root)
  expect(specUnsettledLabel(db(), 'asked-root')).toBeTrue()
})

test('labels a question asked on a later turn positive', () => {
  const root = run({ spec: 'asked-turn', status: 'ok' })
  const turn = run({ spec: 'asked-turn', status: 'ok', parent: root })
  ask(turn)
  expect(specUnsettledLabel(db(), 'asked-turn')).toBeTrue()
})

test('labels a terminal chain without a question negative', () => {
  const root = run({ spec: 'terminal', status: 'ok' })
  run({ spec: 'terminal', status: 'failed', parent: root })
  expect(specUnsettledLabel(db(), 'terminal')).toBeFalse()
})

test('leaves a running chain pending', () => {
  run({ spec: 'running', status: 'running' })
  expect(specUnsettledLabel(db(), 'running')).toBeNull()
})

test('ignores non-implement roots and non-root implement runs with the same spec', () => {
  run({ spec: 'ignored', status: 'ok', job: 'file-question' })
  const root = run({ spec: 'different', status: 'ok' })
  run({ spec: 'ignored', status: 'ok', parent: root })
  expect(specUnsettledLabel(db(), 'ignored')).toBeNull()
})

function answer(input: { question: string; version: number; subject: string; noul: number }): void {
  db()
    .query(
      `INSERT INTO typed_question_answer
       (record_id,question_id,question_version,subject_kind,subject_ref,state_sha,answer_json,
        model,input_tokens,latency_ms,error,created_at)
       VALUES (?,?,?,'spec',?,'state',?,'jev',100,10,NULL,?)`,
    )
    .run(
      newRecordId(),
      input.question,
      input.version,
      input.subject,
      JSON.stringify({ noul: input.noul }),
      new Date().toISOString(),
    )
}

test('reports each version on its own and joins outcomes only for a declared question', () => {
  const current = SPEC_UNSETTLED_QUESTION.version
  ask(run({ spec: 'report-asked', status: 'ok' }))
  run({ spec: 'report-settled', status: 'ok' })
  answer({
    question: SPEC_UNSETTLED_QUESTION.id,
    version: current,
    subject: 'report-asked',
    noul: 0.9,
  })
  answer({
    question: SPEC_UNSETTLED_QUESTION.id,
    version: current,
    subject: 'report-settled',
    noul: 0.2,
  })
  answer({
    question: SPEC_UNSETTLED_QUESTION.id,
    version: current + 1,
    subject: 'report-asked',
    noul: 0.9,
  })
  answer({ question: 'undeclared', version: 1, subject: 'report-asked', noul: 0.9 })

  const report = typedQuestionReport({})
  const declared = report.find(
    (block) => block.questionId === SPEC_UNSETTLED_QUESTION.id && block.questionVersion === current,
  )!
  expect(declared).toMatchObject({
    threshold: SPEC_UNSETTLED_QUESTION.threshold,
    labeled: 2,
    auc: 1,
    precision: 1,
    recall: 1,
  })
  const later = report.find(
    (block) =>
      block.questionId === SPEC_UNSETTLED_QUESTION.id && block.questionVersion === current + 1,
  )!
  expect(later).toMatchObject({ threshold: null, labeled: 1, precision: null, warnedRate: null })
  const undeclared = report.find((block) => block.questionId === 'undeclared')!
  expect(undeclared).toMatchObject({ recorded: 1, threshold: null, labeled: null, auc: null })
})
