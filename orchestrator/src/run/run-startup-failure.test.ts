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

test('a failed reserved continuation rolls its outcome up to the chain root', () => {
  const root = addRun({ agent: 'codex', job: 'review-lens', status: 'asking' })
  const turn = addRun({
    agent: '(pending)',
    job: 'review-lens',
    status: 'running',
    parent: root,
    turn: 2,
  })

  failReservedRun(turn, 'continuation setup failed')

  expect(
    db().query('SELECT status, failure_kind, error FROM run WHERE record_id=?').get(root),
  ).toEqual({
    status: 'failed',
    failure_kind: 'harness',
    error: 'continuation setup failed',
  })
  expect(
    db()
      .query("SELECT row_id FROM outbox WHERE row_id IN (?,?) AND kind='run' ORDER BY row_id")
      .all(root, turn),
  ).toEqual([{ row_id: root }, { row_id: turn }].sort((a, b) => a.row_id.localeCompare(b.row_id)))
})
