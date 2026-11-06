import { afterAll, beforeEach, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import { correctStoredIntervalProjects } from './interval-project-correction.ts'
import { queueHostedChange } from './outbox.ts'

const intervalId = '01990000-0000-7000-8000-000000008001'
const dayOneId = '01990000-0000-7000-8000-000000008002'
const dayTwoId = '01990000-0000-7000-8000-000000008003'

beforeEach(resetFixtureStore)
afterAll(resetFixtureStore)

function insertInterval() {
  writeTransaction((conn) =>
    conn
      .query(`INSERT INTO interval
      (record_id,task_key,project,project_record_id,source,start_at,end_at,claude_tokens,vendor_tokens,ref,open)
      VALUES (?,'DEV-1','workshop','project-id','orch','2026-10-11T10:00:00.000Z',
        '2026-10-11T10:01:00.000Z',10,20,'orch:8001',1)`)
      .run(intervalId),
  )
}

function insertDay(id: string, day: string) {
  writeTransaction((conn) =>
    conn
      .query(`INSERT INTO day(record_id,day,claude_tokens,collected_at)
      VALUES (?,?,10,?)`)
      .run(id, day, `${day}T23:00:00.000Z`),
  )
}

const queued = () =>
  db()
    .query<{ table_name: string; row_id: string; operation: string }, []>(
      `SELECT table_name,row_id,operation FROM hosted_outbox ORDER BY table_name,row_id`,
    )
    .all()

test('restated evidence queues nothing while material interval and day changes queue once', () => {
  insertInterval()
  insertDay(dayOneId, '2026-10-10')
  insertDay(dayTwoId, '2026-10-11')
  writeTransaction((conn) => conn.exec(`DELETE FROM hosted_outbox`))

  writeTransaction((conn) => {
    conn
      .query(`UPDATE interval SET claude_tokens=claude_tokens,end_at=end_at WHERE record_id=?`)
      .run(intervalId)
    conn.query(`UPDATE day SET claude_tokens=claude_tokens,collected_at=collected_at`).run()
  })
  expect(queued()).toEqual([])

  writeTransaction((conn) =>
    conn.query(`UPDATE interval SET claude_tokens=11 WHERE record_id=?`).run(intervalId),
  )
  expect(queued()).toEqual([
    { table_name: 'hub_interval', row_id: intervalId, operation: 'upsert' },
  ])
  writeTransaction((conn) => conn.exec(`DELETE FROM hosted_outbox`))
  writeTransaction((conn) =>
    conn.query(`UPDATE interval SET open=0 WHERE record_id=?`).run(intervalId),
  )
  expect(queued()).toEqual([
    { table_name: 'hub_interval', row_id: intervalId, operation: 'upsert' },
  ])
  writeTransaction((conn) => conn.exec(`DELETE FROM hosted_outbox`))
  writeTransaction((conn) =>
    conn.query(`UPDATE day SET messages=1 WHERE record_id=?`).run(dayTwoId),
  )
  expect(queued()).toEqual([{ table_name: 'hub_day', row_id: dayTwoId, operation: 'upsert' }])

  writeTransaction((conn) => conn.exec(`DELETE FROM hosted_outbox`))
  correctStoredIntervalProjects([
    { name: 'workshop', settings: { keyPrefixes: ['DEV'] } },
    { name: 'corrected', settings: { keyPrefixes: ['FIX'] } },
  ])
  expect(queued()).toEqual([])
  writeTransaction((conn) =>
    conn
      .query(`UPDATE interval SET project='missing',task_key='ALP-1' WHERE record_id=?`)
      .run(intervalId),
  )
  writeTransaction((conn) => conn.exec(`DELETE FROM hosted_outbox`))
  correctStoredIntervalProjects([{ name: 'alpha', settings: { keyPrefixes: ['ALP'] } }])
  expect(queued()).toEqual([
    { table_name: 'hub_interval', row_id: intervalId, operation: 'upsert' },
  ])
})

test('the newest day queues only when its content changes', () => {
  insertDay(dayOneId, '2026-10-10')
  insertDay(dayTwoId, '2026-10-11')
  writeTransaction((conn) => conn.exec(`DELETE FROM hosted_outbox`))
  writeTransaction((conn) =>
    conn
      .query(`UPDATE day SET collected_at='2026-10-12T00:00:00.000Z' WHERE record_id=?`)
      .run(dayTwoId),
  )
  expect(queued()).toEqual([])

  writeTransaction((conn) =>
    conn.query(`UPDATE day SET claude_tokens=11 WHERE record_id=?`).run(dayTwoId),
  )
  expect(queued()).toEqual([{ table_name: 'hub_day', row_id: dayTwoId, operation: 'upsert' }])
})

test('a day content change re-queues a held entry with its delivery state cleared', () => {
  insertDay(dayTwoId, '2026-10-11')
  writeTransaction((conn) =>
    conn
      .query(`UPDATE hosted_outbox SET generation=4,attempts=3,last_error='push failed',
        quarantined_at='2026-10-11T23:30:00.000Z',quarantine_reason='rejected',
        routing_space_id='space',routing_project='workshop',routing_project_record_id='project-id'
        WHERE table_name='hub_day' AND row_id=?`)
      .run(dayTwoId),
  )

  writeTransaction((conn) =>
    conn.query(`UPDATE day SET claude_tokens=11 WHERE record_id=?`).run(dayTwoId),
  )
  expect(
    db()
      .query(`SELECT generation,attempts,last_error,quarantined_at,quarantine_reason,
        routing_space_id,routing_project,routing_project_record_id
        FROM hosted_outbox WHERE table_name='hub_day' AND row_id=?`)
      .get(dayTwoId),
  ).toEqual({
    generation: 5,
    attempts: 0,
    last_error: null,
    quarantined_at: null,
    quarantine_reason: null,
    routing_space_id: null,
    routing_project: null,
    routing_project_record_id: null,
  })
})

test('a new day queues exactly one entry', () => {
  insertDay(dayOneId, '2026-10-10')
  expect(queued()).toEqual([{ table_name: 'hub_day', row_id: dayOneId, operation: 'upsert' }])
})

test('a trigger and queueHostedChange produce the same queue state except id and time', () => {
  insertInterval()
  writeTransaction((conn) => {
    conn.exec(`UPDATE hosted_outbox SET attempts=2,last_error='rejected',
      quarantined_at='2026-10-11T11:00:00.000Z',quarantine_reason='rejected'`)
    conn.query(`UPDATE interval SET open=0 WHERE record_id=?`).run(intervalId)
  })
  const triggered = db().query<Record<string, unknown>, []>(`SELECT * FROM hosted_outbox`).get()!
  writeTransaction((conn) => {
    conn.exec(`DELETE FROM hosted_outbox`)
    conn
      .query(`INSERT INTO hosted_outbox
      (id,table_name,row_id,operation,queued_at,attempts,last_error,quarantined_at,quarantine_reason)
      VALUES ('prior','hub_interval',?,'upsert','2026-10-11T11:00:00.000Z',2,'rejected',
        '2026-10-11T11:00:00.000Z','rejected')`)
      .run(intervalId)
    queueHostedChange(conn, 'hub_interval', intervalId, 'upsert', '2026-10-11T12:00:00.000Z')
  })
  const explicit = db().query<Record<string, unknown>, []>(`SELECT * FROM hosted_outbox`).get()!
  for (const key of ['id', 'queued_at']) {
    delete triggered[key]
    delete explicit[key]
  }
  expect(triggered).toEqual(explicit)
})
