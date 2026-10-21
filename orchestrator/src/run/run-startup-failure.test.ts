import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { failReservedRun } from './run-startup-failure.ts'

test('a refusal after detach keeps the printed run queryable as failed', () => {
  const id = addRun({ agent: '(pending)', job: 'review-lens', status: 'running' })

  failReservedRun(id, new Error('selected transport refused the launch'))

  expect(
    db().query('SELECT status, failure_kind, error, latency_ms FROM run WHERE record_id=?').get(id),
  ).toEqual({
    status: 'failed',
    failure_kind: 'harness',
    error: 'selected transport refused the launch',
    latency_ms: 0,
  })
  expect(db().query("SELECT kind FROM outbox WHERE row_id=? AND kind='run'").get(id)).toEqual({
    kind: 'run',
  })
})
