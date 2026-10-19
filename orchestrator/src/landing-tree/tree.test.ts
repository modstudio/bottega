import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { removeHookTree } from '../hook-tree/tree.ts'
import { landingTreeSeedRequest, landingTreeSourceRun, releaseFailedLandingTree } from './tree.ts'

test('landing-tree seed request carries the recorded launch seed', () => {
  expect(
    landingTreeSeedRequest({
      requested: undefined,
      recordedLaunchSeed: 'recorded',
      project: null,
      tool: null,
      baseRef: 'tip',
    }),
  ).toMatchObject({ requested: undefined, inherited: 'recorded', baseRef: 'tip' })
})

test('landing tree opening resolves a root run by its UUID', () => {
  const root = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  expect(landingTreeSourceRun(root)).toMatchObject({
    root: { record_id: root },
    latest: { record_id: root },
  })
})

test('landing tree opening resolves a turn to its root and latest UUID', () => {
  const root = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
  const turn = addRun({ agent: 'codex', job: 'implement', status: 'ok', parent: root, turn: 2 })
  expect(landingTreeSourceRun(turn)).toMatchObject({
    root: { record_id: root },
    latest: { record_id: turn },
  })
})

test('failed creation settles its worktree claim after the recipe already removed the directory', () => {
  const id = addRun({ agent: '(architect)', job: 'landing-tree', status: 'failed' })
  const missing = `/no-such-landing-tree-${id}`
  db().query('UPDATE run SET worktree=?, cwd=? WHERE record_id=?').run(missing, missing, id)
  db()
    .query(
      `INSERT INTO resource_claim
       (record_id, root_run_record_id,run_record_id,kind,allocation_key,state,claimed_at)
       VALUES ('${newRecordId()}', ?,?,'worktree',?,'claimed',?)`,
    )
    .run(id, id, missing, '2026-09-22T00:00:00.000Z')

  releaseFailedLandingTree(id)

  expect(
    db()
      .query("SELECT state FROM resource_claim WHERE root_run_record_id=? AND kind='worktree'")
      .get(id),
  ).toEqual({ state: 'absent' })
})

test.each(['landing-tree', 'hook-tree'])(
  'tree remove settles an absent %s run found by its durable claim',
  (job) => {
    const id = addRun({ agent: '(architect)', job, status: 'ok' })
    const missing = `/no-such-${job}-${id}`
    db()
      .query(
        `INSERT INTO resource_claim
         (record_id, root_run_record_id,run_record_id,kind,allocation_key,state,claimed_at)
         VALUES ('${newRecordId()}', ?,?,'worktree',?,'claimed',?)`,
      )
      .run(id, id, missing, '2026-09-23T00:00:00.000Z')

    removeHookTree(missing)

    expect(db().query('SELECT close_out_outcome FROM run WHERE record_id=?').get(id)).toEqual({
      close_out_outcome: 'absent',
    })
    expect(
      db()
        .query("SELECT state FROM resource_claim WHERE root_run_record_id=? AND kind='worktree'")
        .get(id),
    ).toEqual({ state: 'absent' })
  },
)
