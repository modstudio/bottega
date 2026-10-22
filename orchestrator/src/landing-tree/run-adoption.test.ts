import { afterEach, beforeEach, expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { adoptCoordinatorRunsForLanding } from './run-adoption.ts'

const architectSession = 'architect-session'

beforeEach(() => {
  process.env.CLAUDE_CODE_SESSION_ID = architectSession
})

afterEach(() => {
  delete process.env.CLAUDE_CODE_SESSION_ID
})

function coordinatorRun(input: {
  job: string
  key: string
  label: string
  owner?: string
}): string {
  const id = addRun({ agent: 'codex', job: input.job, session: input.owner ?? 'operator:machine' })
  db()
    .query('UPDATE run SET launch_key=?,label=? WHERE record_id=?')
    .run(input.key, input.label, id)
  return id
}

test('landing adoption transfers same-key and recorded cross-key coordinator conversations', () => {
  const fix = coordinatorRun({ job: 'issue-worker', key: 'FIX-42', label: 'issue DEV-1528 fix' })
  const diagnosis = coordinatorRun({
    job: 'diagnose',
    key: 'DEV-1528',
    label: 'issue DEV-1528 diagnosis',
  })
  const turn = addRun({
    agent: 'codex',
    job: 'diagnose',
    parent: diagnosis,
    turn: 2,
    session: 'operator:machine',
  })
  const sameKey = coordinatorRun({
    job: 'review-lens',
    key: 'FIX-42',
    label: 'unrelated label',
  })
  const differentOwner = coordinatorRun({
    job: 'review-lens',
    key: 'FIX-42',
    label: 'issue DEV-1528 review correctness',
    owner: 'operator:other-machine',
  })

  expect(
    adoptCoordinatorRunsForLanding({
      record_id: fix,
      session_id: 'operator:machine',
      launch_key: 'FIX-42',
      job: 'issue-worker',
      label: 'issue DEV-1528 fix',
    }),
  ).toBe(3)

  expect(
    db()
      .query<{ record_id: string; session_id: string | null }, []>(
        'SELECT record_id,session_id FROM run ORDER BY number',
      )
      .all()
      .filter((row) => [fix, diagnosis, turn, sameKey, differentOwner].includes(row.record_id)),
  ).toEqual([
    { record_id: fix, session_id: architectSession },
    { record_id: diagnosis, session_id: architectSession },
    { record_id: turn, session_id: architectSession },
    { record_id: sameKey, session_id: architectSession },
    { record_id: differentOwner, session_id: 'operator:other-machine' },
  ])
  expect(
    db()
      .query(
        "SELECT run_record_id,action,actor_session FROM run_mutation_audit WHERE action='adopt'",
      )
      .all(),
  ).toEqual([
    { run_record_id: fix, action: 'adopt', actor_session: architectSession },
    { run_record_id: diagnosis, action: 'adopt', actor_session: architectSession },
    { run_record_id: sameKey, action: 'adopt', actor_session: architectSession },
  ])
  expect(
    db()
      .query<{ row_id: string }, []>("SELECT row_id FROM outbox WHERE kind='run' ORDER BY id")
      .all()
      .map((row) => row.row_id),
  ).toEqual([fix, diagnosis, turn, sameKey])
})
