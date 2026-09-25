import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { continuationCheckpointContext } from './continuation-checkpoint-context.ts'

test('uses the resolved continuation tree tip as the checkpoint prompt start', () => {
  const rootId = addRun({ agent: 'codex', job: 'implement' })
  db()
    .query(
      `INSERT INTO run_checkpoint
         (run_id,checkpoint_no,commit_sha,task_pointer,final,created_at)
       VALUES (?,?,?,?,?,?)`,
    )
    .run(rootId, 2, 'earlier-checkpoint', null, 0, new Date().toISOString())

  const context = continuationCheckpointContext({
    database: db(),
    rootId,
    worktree: null,
    treePlan: {
      action: 'attach-recorded',
      branch: 'DEV-970-resume-tip',
      tip: 'resolved-branch-tip',
      tipSource: 'branch ref',
      rootId,
    },
  })

  expect(context).toContain('Resume at resolved-branch-tip on DEV-970-resume-tip.')
  expect(context).toContain(
    'Latest harness checkpoint #2 at earlier-checkpoint is earlier than the start commit',
  )
  expect(context).not.toContain('Resume from checkpoint')
})

test('a checkpoint without a resolved continuation tree gives the fresh-run remedy', () => {
  const rootId = addRun({ agent: 'codex', job: 'implement' })
  db().query('UPDATE run SET launch_key=? WHERE id=?').run('DEV-970', rootId)
  db()
    .query(
      `INSERT INTO run_checkpoint
         (run_id,checkpoint_no,commit_sha,task_pointer,final,created_at)
       VALUES (?,?,?,?,?,?)`,
    )
    .run(rootId, 1, 'checkpoint-without-tree', null, 0, new Date().toISOString())

  expect(() =>
    continuationCheckpointContext({
      database: db(),
      rootId,
      worktree: null,
      treePlan: null,
    }),
  ).toThrow(
    `run ${rootId} has a checkpoint but no branch or retained ref resolves for its latest started turn; ` +
      'invariant: a resume prompt names only the commit the resumed tree exposes; ' +
      'remedy: start a fresh keyed run from a known base with orch do implement --key DEV-970 --base <ref>',
  )
})
