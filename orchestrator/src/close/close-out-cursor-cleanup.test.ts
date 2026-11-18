import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { addRun } from '../../test/fixtures/store.ts'
import {
  addOpenCursorWorktree,
  hostedCursorStageFixture,
} from '../../test/fixtures/workflow.ts'
import {
  closeDatabaseForFixture,
  db,
  withSynchronousDatabaseForMigrationStep,
} from '../database/db.ts'
import { closeOutRun } from './close-out.ts'
import { prepareCloseOut, prepareCursorWorktreeClear } from './close-out-preparation.ts'

test('a failed close-out clears cursor pointers when the tree is already gone', async () => {
  const id = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const path = `/no-such-failed-cursor-cleanup-tree-${id}`
  db().query('UPDATE run SET worktree=?,cwd=? WHERE record_id=?').run(path, path, id)
  const cursor = addOpenCursorWorktree(db(), { project: 'run-fixture', worktree: path })
  const cursorRecordId = db()
    .query<{ record_id: string }, [number]>(
      'SELECT record_id FROM workflow_cursor WHERE number=?',
    )
    .get(cursor)!.record_id
  const hostedStage = hostedCursorStageFixture(db(), cursorRecordId)
  const previousRecordUrl = process.env.BOTTEGA_RECORD_API_URL
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  db()
    .query('UPDATE project SET settings=?')
    .run(JSON.stringify({ trunk: 'main', space: 'fixture-space-id' }))
  db()
    .query(
      `INSERT INTO record_install_binding (id,bound_at,record_origin)
       VALUES (1,'2026-11-18T00:00:00.000Z','https://record.example.test')`,
    )
    .run()
  const memory = createMemoryRecordApiClient({ taskFlowStages: [hostedStage] })
  const taskFlowClient = {
    ...memory,
    whoami: async () => ({
      user: { id: 'fixture-user' },
      activeSpaceId: 'fixture-space-id',
      personalSpaceId: 'fixture-space-id',
      memberships: [
        { space_id: 'fixture-space-id', slug: 'fixture-space', permission: 'write' as const },
      ],
    }),
  }
  installRecordApiClient(taskFlowClient)
  closeDatabaseForFixture()

  try {
    const clear = prepareCursorWorktreeClear(id, await prepareCloseOut(taskFlowClient))
    expect(
      await clear({ runId: id, worktree: path, outcome: 'failed', detail: 'remover failed' }),
    ).toBeNull()
    expect(hostedStage.stage.arguments).toEqual({})
    expect(hostedStage.stage.closedStepNotes).toContainEqual(
      expect.objectContaining({ event: 'argument-rebound', name: 'worktree', oldValue: path }),
    )
  } finally {
    closeDatabaseForFixture()
    withSynchronousDatabaseForMigrationStep((database) =>
      database.query('DELETE FROM record_install_binding').run(),
    )
    if (previousRecordUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
    else process.env.BOTTEGA_RECORD_API_URL = previousRecordUrl
    installRecordApiClient(createMemoryRecordApiClient())
  }
})

test('tree removal reports a cursor cleanup failure without changing the absent outcome', async () => {
  const id = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const path = `/no-such-cursor-cleanup-tree-${id}`
  db().query('UPDATE run SET worktree=?,cwd=? WHERE record_id=?').run(path, path, id)
  const cursor = addOpenCursorWorktree(db(), { project: 'run-fixture', worktree: path })
  const cursorRecordId = db()
    .query<{ record_id: string }, [number]>(
      'SELECT record_id FROM workflow_cursor WHERE number=?',
    )
    .get(cursor)!.record_id
  const hostedStage = hostedCursorStageFixture(db(), cursorRecordId)
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
    ...createMemoryRecordApiClient({ taskFlowStages: [hostedStage] }),
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
