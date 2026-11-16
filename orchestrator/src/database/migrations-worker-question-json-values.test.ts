import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { applyMigrations } from './migrations.ts'
import { fixtureProjectRecordId, migrationBoundaryTestDatabase } from './test-database.fixture.ts'

const MIGRATION = '0231_worker_question_json_values'
const STAMP = '2026-11-16T12:00:00.000Z'

test('repairs only double-encoded question JSON values and pending question payloads', () => {
  const database = migrationBoundaryTestDatabase(MIGRATION)
  const projectId = fixtureProjectRecordId(database)
  const runId = newRecordId()
  const brokenQuestionId = newRecordId()
  const correctQuestionId = newRecordId()
  const brokenPayloadId = newRecordId()
  const syncedPayloadId = newRecordId()
  database
    .query(
      `INSERT INTO run
       (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,project_record_id)
       VALUES (?,91,?,'codex','implement','sha',1,'prompt','asking',?)`,
    )
    .run(runId, STAMP, projectId)
  database
    .query(
      `INSERT INTO question
       (record_id,number,run_record_id,asked_at,question,kind,typed_options,criteria,levels,options,jev_probabilities)
       VALUES (?,91,?,?,?,'choice',?,?,?,?,?)`,
    )
    .run(
      brokenQuestionId,
      runId,
      STAMP,
      'Broken?',
      JSON.stringify(JSON.stringify([{ name: 'one' }, { name: 'two' }])),
      JSON.stringify(JSON.stringify({ yes: 'go', no: 'stop' })),
      JSON.stringify(JSON.stringify(['low', 'high'])),
      JSON.stringify(JSON.stringify(['one', 'two'])),
      JSON.stringify(JSON.stringify({ one: 0.8, two: 0.2 })),
    )
  database
    .query(
      `INSERT INTO question
       (record_id,number,run_record_id,asked_at,question,kind,typed_options,criteria,levels,options,jev_probabilities)
       VALUES (?,92,?,?,?,'choice',?,?,?,?,?)`,
    )
    .run(
      correctQuestionId,
      runId,
      STAMP,
      'Correct?',
      JSON.stringify([{ name: 'one' }, { name: 'two' }]),
      JSON.stringify({ yes: 'go', no: 'stop' }),
      JSON.stringify(['low', 'high']),
      JSON.stringify(['one', 'two']),
      JSON.stringify({ one: 0.8, two: 0.2 }),
    )
  const brokenPayload = {
    typedOptions: JSON.stringify([{ name: 'one' }, { name: 'two' }]),
    criteria: JSON.stringify({ yes: 'go', no: 'stop' }),
    levels: JSON.stringify(['low', 'high']),
    options: JSON.stringify(['one', 'two']),
    jevProbabilities: JSON.stringify({ one: 0.8, two: 0.2 }),
  }
  database
    .query(
      `INSERT INTO outbox
       (record_id,kind,row_id,payload,created_at,quarantined_at,quarantine_reason)
       VALUES (?,'question',?,?,?,?,'invalid typed values')`,
    )
    .run(brokenPayloadId, brokenQuestionId, JSON.stringify(brokenPayload), STAMP, STAMP)
  database
    .query(
      `INSERT INTO outbox (record_id,kind,row_id,payload,created_at,synced_at)
       VALUES (?,'question',?,?,?,?)`,
    )
    .run(syncedPayloadId, correctQuestionId, JSON.stringify(brokenPayload), STAMP, STAMP)

  expect(applyMigrations(database)).toContain(MIGRATION)
  const repaired = database
    .query<
      {
        typed_options: string
        criteria: string
        levels: string
        options: string
        jev_probabilities: string
      },
      [string]
    >(
      'SELECT typed_options,criteria,levels,options,jev_probabilities FROM question WHERE record_id=?',
    )
    .get(brokenQuestionId)!
  expect(JSON.parse(repaired.typed_options)).toEqual([{ name: 'one' }, { name: 'two' }])
  expect(JSON.parse(repaired.criteria)).toEqual({ yes: 'go', no: 'stop' })
  expect(JSON.parse(repaired.levels)).toEqual(['low', 'high'])
  expect(JSON.parse(repaired.options)).toEqual(['one', 'two'])
  expect(JSON.parse(repaired.jev_probabilities)).toEqual({ one: 0.8, two: 0.2 })

  const pending = database
    .query<
      { payload: string; quarantined_at: string | null; quarantine_reason: string | null },
      [string]
    >('SELECT payload,quarantined_at,quarantine_reason FROM outbox WHERE record_id=?')
    .get(brokenPayloadId)!
  expect(JSON.parse(pending.payload)).toEqual({
    typedOptions: [{ name: 'one' }, { name: 'two' }],
    criteria: { yes: 'go', no: 'stop' },
    levels: ['low', 'high'],
    options: ['one', 'two'],
    jevProbabilities: { one: 0.8, two: 0.2 },
  })
  expect(pending).toMatchObject({
    quarantined_at: STAMP,
    quarantine_reason: 'invalid typed values',
  })
  expect(
    database
      .query<{ payload: string }, [string]>('SELECT payload FROM outbox WHERE record_id=?')
      .get(syncedPayloadId)!.payload,
  ).toBe(JSON.stringify(brokenPayload))

  const correctBefore = database
    .query<{ typed_options: string; criteria: string; levels: string; options: string }, [string]>(
      'SELECT typed_options,criteria,levels,options FROM question WHERE record_id=?',
    )
    .get(correctQuestionId)!
  applyMigrations(database)
  expect(
    database
      .query('SELECT typed_options,criteria,levels,options FROM question WHERE record_id=?')
      .get(correctQuestionId),
  ).toEqual(correctBefore)
  database.close()
})
