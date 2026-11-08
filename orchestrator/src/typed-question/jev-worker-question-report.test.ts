import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
import { fixtureProjectRecordId } from '../database/test-database.fixture.ts'
import { jevWorkerQuestionReport } from './jev-worker-question-report-reader.ts'
import {
  type JevWorkerQuestionRow,
  jevWorkerQuestionMetrics,
} from './jev-worker-question-report.ts'

function row(input: Partial<JevWorkerQuestionRow> = {}): JevWorkerQuestionRow {
  return {
    kind: 'choice',
    jev_model: 'jev-1.14.0',
    jev_pick: '"a"',
    jev_probabilities: '{"a":0.9,"b":0.1}',
    jev_agreed: 1,
    ...input,
  }
}

test('measures agreement, calibration bands, threshold reliability, and brier', () => {
  const metrics = jevWorkerQuestionMetrics(
    [
      row(),
      row({ jev_probabilities: '{"a":0.8,"b":0.2}', jev_agreed: 0 }),
      row({ jev_probabilities: '{"a":0.6,"b":0.4}', jev_agreed: null }),
    ],
    0.85,
  )[0]!
  expect(metrics).toMatchObject({
    kind: 'all',
    advised: 3,
    ruledByArchitect: 2,
    agreed: 1,
    agreementRate: 0.5,
    unreadable: 0,
    coverage: 0.5,
    agreementAtThreshold: 1,
  })
  expect(metrics.brier).toBeCloseTo((0.01 + 0.64) / 2)
  expect(metrics.bands.find((band) => band.range === '[0.8,0.9)')).toMatchObject({
    n: 1,
    agreementRate: 0,
  })
  expect(metrics.bands.find((band) => band.range === '[0.9,0.95)')).toMatchObject({
    n: 1,
    agreementRate: 1,
  })
})

test('computes yes/no and score pick probabilities and splits kind-model cohorts', () => {
  const metrics = jevWorkerQuestionMetrics(
    [
      row({
        kind: 'yesno',
        jev_pick: 'false',
        jev_probabilities: '{"yes":0.2,"no":0.8}',
      }),
      row({
        kind: 'score',
        jev_model: null,
        jev_pick: '2',
        jev_probabilities: '{"0":0.1,"1":0.2,"2":0.7}',
      }),
    ],
    0.75,
  )
  expect(metrics).toHaveLength(3)
  expect(metrics[0]).toMatchObject({ coverage: 0.5, agreementAtThreshold: 1 })
  expect(metrics[1]).toMatchObject({ kind: 'yesno', model: 'jev-1.14.0', coverage: 1 })
  expect(metrics[2]).toMatchObject({ kind: 'score', model: null, coverage: 0 })
})

test('keeps named and null models in separate cohorts for the same kind', () => {
  const metrics = jevWorkerQuestionMetrics(
    [row(), row({ jev_model: null, jev_probabilities: '{"a":0.8,"b":0.2}' })],
    0.75,
  )
  expect(metrics).toHaveLength(3)
  expect(metrics[1]).toMatchObject({ kind: 'choice', model: 'jev-1.14.0', advised: 1 })
  expect(metrics[2]).toMatchObject({ kind: 'choice', model: null, advised: 1 })
})

test('counts unreadable advice instead of dropping it', () => {
  const metrics = jevWorkerQuestionMetrics(
    [row({ jev_probabilities: 'not-json' }), row({ jev_pick: 'null' })],
    0.9,
  )[0]!
  expect(metrics).toMatchObject({ advised: 2, ruledByArchitect: 2, unreadable: 2, coverage: 0 })
  expect(metrics.brier).toBeNull()
  expect(metrics.agreementAtThreshold).toBeNull()
})

test('reads advised questions from the store and filters days by asked_at', () => {
  const database = db()
  const runId = newRecordId()
  database
    .query(
      `INSERT INTO run
       (record_id,number,started_at,agent,job,prompt_sha,spec_sha,prompt_bytes,prompt_head,status,
        turn,project_record_id)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM run),?,'codex','implement','prompt','spec',1,
               'prompt','ok',1,?)`,
    )
    .run(runId, new Date().toISOString(), fixtureProjectRecordId(database))
  const insert = database.query(
    `INSERT INTO question
     (record_id,number,run_record_id,asked_at,question,kind,jev_pick,jev_probabilities,jev_model,jev_agreed)
     VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM question),?,?,?,?,?,?,?,?)`,
  )
  insert.run(
    newRecordId(),
    runId,
    new Date().toISOString(),
    'answered advice',
    'choice',
    '"a"',
    '{"a":0.9,"b":0.1}',
    'jev-1.14.0',
    1,
  )
  insert.run(
    newRecordId(),
    runId,
    '2000-01-01T00:00:00.000Z',
    'unanswered advice',
    'yesno',
    'true',
    '{"yes":0.8,"no":0.2}',
    'jev-1.14.0',
    null,
  )
  insert.run(
    newRecordId(),
    runId,
    new Date().toISOString(),
    'text question',
    'text',
    null,
    null,
    null,
    null,
  )

  expect(jevWorkerQuestionReport({}, database)[0]).toMatchObject({
    advised: 2,
    ruledByArchitect: 1,
  })
  expect(jevWorkerQuestionReport({ days: 1 }, database)[0]).toMatchObject({
    advised: 1,
    ruledByArchitect: 1,
  })
})

test('refuses an invalid configured threshold with the remedy', () => {
  expect(() => jevWorkerQuestionReport({}, db(), () => 'invalid')).toThrow(
    `invalid jev.confidence_threshold "invalid"; run ${PLATFORM_SLUG} machine config set jev.confidence_threshold <0-1>`,
  )
})
