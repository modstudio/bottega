import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db, nowIso } from '../database/db.ts'
import { refuseMissingChainTreeDatabase } from './chain-database-guard.ts'

test('recreate refuses a held database as leaked state without prescribing cleanup', () => {
  const root = addRun({ agent: 'codex', job: 'implement', status: 'failed' })
  const owner = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'failed',
    parent: root,
    turn: 2,
  })
  db()
    .query(
      `INSERT INTO resource_claim
     (record_id,root_run_record_id,run_record_id,kind,allocation_key,state,claimed_at)
     VALUES (?,?,?,'database','postgres:stopal_orch_3','retained',?)`,
    )
    .run(newRecordId(), root, owner, nowIso())

  expect(() => refuseMissingChainTreeDatabase(root)).toThrow(
    `stopal_orch_3 (owning turn ${owner}, resource_claim state retained)`,
  )
  try {
    refuseMissingChainTreeDatabase(root)
  } catch (error) {
    const message = (error as Error).message
    expect(message).toContain('report to the architect')
    expect(message).not.toMatch(/run (?:discard|close-out)|machine sweep/)
  }
})

test('a dirty detached chain tree with a held database gets the dirty remedy', () => {
  const root = addRun({ agent: 'codex', job: 'implement', status: 'failed' })
  const owner = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'failed',
    parent: root,
    turn: 2,
  })
  db()
    .query(
      `INSERT INTO resource_claim
     (record_id,root_run_record_id,run_record_id,kind,allocation_key,state,claimed_at)
     VALUES (?,?,?,'database','postgres:stopal_orch_3','retained',?)`,
    )
    .run(newRecordId(), root, owner, nowIso())

  expect(() =>
    refuseMissingChainTreeDatabase(root, {
      dirtyTreePath: '/trees/dirty-detached',
      retryCommand: `${PLATFORM_SLUG} run continue ${root}`,
    }),
  ).toThrow(
    `stopal_orch_3 (owning turn ${owner}, resource_claim state retained); ` +
      `commit or discard the uncommitted changes in /trees/dirty-detached`,
  )
})

test('a dirty detached chain tree without a held database does not refuse recreation', () => {
  const root = addRun({ agent: 'codex', job: 'implement', status: 'failed' })
  expect(() =>
    refuseMissingChainTreeDatabase(root, { dirtyTreePath: '/trees/dirty-detached' }),
  ).not.toThrow()
})

test('database collision pre-check is skipped for a recipe that declares reuse', () => {
  const root = addRun({ agent: 'codex', job: 'implement', status: 'failed' })
  db()
    .query('UPDATE run SET recipe_snapshot=? WHERE record_id=?')
    .run(
      JSON.stringify({
        source: { path: `.${PLATFORM_SLUG}/worktree.jsonc`, commit: 'a'.repeat(40) },
        recipe: {
          create: [],
          allocate: {
            databases: {
              app: {
                engine: 'postgres',
                name: 'stopal_orch_3',
                provision: {
                  from: 'stopal_base',
                  connection: { key: 'DATABASE_URL' },
                  reuse: true,
                },
              },
            },
          },
        },
      }),
      root,
    )
  db()
    .query(
      `INSERT INTO resource_claim
     (record_id,root_run_record_id,run_record_id,kind,allocation_key,state,claimed_at)
     VALUES (?,?,?,'database','postgres:stopal_orch_3','retained',?)`,
    )
    .run(newRecordId(), root, root, nowIso())

  expect(() => refuseMissingChainTreeDatabase(root)).not.toThrow()
})
