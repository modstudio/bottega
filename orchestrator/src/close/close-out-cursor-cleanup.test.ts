import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { addOpenCursorWorktree } from '../../test/fixtures/workflow.ts'
import { db } from '../database/db.ts'
import { closeOutRun } from './close-out.ts'
import { prepareCloseOut, prepareCursorWorktreeClear } from './close-out-preparation.ts'

test('a failed close-out clears cursor pointers when the tree is already gone', async () => {
  const id = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const path = `/no-such-failed-cursor-cleanup-tree-${id}`
  db().query('UPDATE run SET worktree=?,cwd=? WHERE record_id=?').run(path, path, id)
  addOpenCursorWorktree(db(), { project: 'run-fixture', worktree: path })
  const clear = prepareCursorWorktreeClear(id, await prepareCloseOut())

  expect(
    await clear({ runId: id, worktree: path, outcome: 'failed', detail: 'remover failed' }),
  ).toBeNull()
  expect(
    db()
      .query<{ args: string }, []>('SELECT args FROM workflow_cursor')
      .all()
      .map((row) => JSON.parse(row.args)),
  ).toEqual([{}])
})

test('tree removal reports a cursor cleanup failure without changing the absent outcome', async () => {
  const id = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const path = `/no-such-cursor-cleanup-tree-${id}`
  db().query('UPDATE run SET worktree=?,cwd=? WHERE record_id=?').run(path, path, id)
  const cursor = addOpenCursorWorktree(db(), { project: 'run-fixture', worktree: path })
  const previousRecordUrl = process.env.BOTTEGA_RECORD_API_URL
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  db()
    .query('UPDATE project SET settings=?')
    .run(JSON.stringify({ trunk: 'main', space: 'fixture-space-id' }))
  db()
    .query(
      `INSERT OR REPLACE INTO record_install_binding (id,bound_at,record_origin)
       VALUES (1,'2026-11-18T00:00:00.000Z','https://record.example.test')`,
    )
    .run()
  const taskFlowClient = {
    ...createMemoryRecordApiClient(),
    whoami: async () => ({
      user: { id: 'fixture-user' },
      activeSpaceId: 'fixture-space-id',
      personalSpaceId: 'fixture-space-id',
      memberships: [{ space_id: 'fixture-space-id', slug: 'fixture-space', permission: 'write' }],
    }),
    updateTaskFlowStage: async () => {
      throw new Error('record down')
    },
  }
  installRecordApiClient(taskFlowClient)

  try {
    const result = await closeOutRun(id, { intent: 'tree-remove', taskFlowClient })

    expect(result).toMatchObject({
      outcome: 'absent',
      cursorCleanupFailure:
        `the tree at ${path} was absent but the worktree pointers for cursor ${cursor} could not be cleared: record down; ` +
        `cleared by: ${PLATFORM_SLUG} workflow step ship-task --cursor ${cursor} --project run-fixture --arg 'worktree=<tree>'`,
      cursorCleanupRemedy:
        `${PLATFORM_SLUG} workflow step ship-task --cursor ${cursor} --project run-fixture ` +
        `--arg 'worktree=<tree>'`,
    })
  } finally {
    if (previousRecordUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
    else process.env.BOTTEGA_RECORD_API_URL = previousRecordUrl
    db().query('DELETE FROM record_install_binding').run()
    installRecordApiClient(createMemoryRecordApiClient())
  }
})
