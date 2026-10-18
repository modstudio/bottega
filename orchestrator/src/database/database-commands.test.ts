import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { PRELOAD_RUNS } from '../../test/preload.ts'
import { applyRunFilesystemIdentityCutover, migrateCommand } from './database-commands.ts'
import { closeDatabaseForFixture, db } from './db.ts'
import {
  applyMigrations,
  applyMigrationsBefore,
  migrationApplied,
  migrationJournal,
} from './migrations.ts'

function actions(fill: () => Promise<unknown>, contracted = false) {
  const calls: string[] = []
  return {
    calls,
    value: {
      async contracted() {
        calls.push('contracted')
        return contracted
      },
      migrate(input?: { beforeMigration?: string }) {
        calls.push(input?.beforeMigration ? `before:${input.beforeMigration}` : 'after')
        return { path: '/store', versions: input ? ['0113'] : ['0114'] }
      },
      async fill() {
        calls.push('fill')
        return fill()
      },
      backfill() {
        calls.push('backfill')
        return { updated: 0, missing: 0 }
      },
    },
  }
}

test('migrate contracts only after identity fill succeeds', async () => {
  const scenario = actions(async () => undefined)
  await migrateCommand({ log: () => {} }, scenario.value)
  expect(scenario.calls).toEqual([
    'contracted',
    'before:0115_project_identity_contract',
    'fill',
    'before:0121_run_filesystem_identity_cutover',
    'after',
    'backfill',
  ])
})

test('migrate stops before contraction when configured hosting refuses the fill', async () => {
  const scenario = actions(async () => {
    throw new Error(`hosted record unreachable; cleared by: ${PLATFORM_SLUG} record doctor`)
  })
  await expect(migrateCommand({ log: () => {} }, scenario.value)).rejects.toThrow(
    `cleared by: ${PLATFORM_SLUG} record doctor`,
  )
  expect(scenario.calls).toEqual(['contracted', 'before:0115_project_identity_contract', 'fill'])
})

test('migrate skips the boundary and fill when the identity contract is recorded', async () => {
  const scenario = actions(async () => {
    throw new Error('fill must not run')
  }, true)
  await migrateCommand({ log: () => {} }, scenario.value)
  expect(scenario.calls).toEqual([
    'contracted',
    'before:0121_run_filesystem_identity_cutover',
    'after',
    'backfill',
  ])
})

const FENCE = '0121_run_filesystem_identity_cutover'
const fixturePaths: string[] = []

afterEach(() => {
  for (const path of fixturePaths.splice(0)) rmSync(path, { recursive: true, force: true })
})

function inspectStore<T>(read: (database: Database) => T): T {
  closeDatabaseForFixture()
  const database = new Database(process.env.ORCH_DB!, { readwrite: true, create: false })
  try {
    return read(database)
  } finally {
    database.close()
  }
}

const fenceApplied = (): boolean => inspectStore((database) => migrationApplied(database, FENCE))

function pendingFenceFixture(status: 'ok' | 'asking', numericFolder: boolean, deleteFence = true) {
  const database = db()
  const fence = migrationJournal().find((entry) => entry.tag === FENCE)!
  if (deleteFence) database.query('DELETE FROM orch_migrations WHERE created_at=?').run(fence.when)
  database.run(
    "UPDATE run SET status='ok' WHERE status IN ('reserved','attached','running','asking')",
  )
  const recordId = randomUUID()
  const inserted = database
    .query(
      `INSERT INTO run
       (record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
       VALUES (?,datetime('now'),'codex','migration-fixture','sha',0,'',?)`,
    )
    .run(recordId, status)
  const id = Number(inserted.lastInsertRowid)
  const numericPath = join(PRELOAD_RUNS, String(id))
  const uuidPath = join(PRELOAD_RUNS, recordId)
  fixturePaths.push(numericPath, uuidPath)
  if (numericFolder) mkdirSync(numericPath, { recursive: true })
  closeDatabaseForFixture()
  return { id, recordId }
}

test('pending conversion on a quiet machine converts files and advances through the fence', async () => {
  const fixture = pendingFenceFixture('ok', true)
  await migrateCommand({ log: () => {} })
  expect(existsSync(join(PRELOAD_RUNS, fixture.recordId))).toBeTrue()
  expect(existsSync(join(PRELOAD_RUNS, String(fixture.id)))).toBeFalse()
  expect(fenceApplied()).toBeTrue()
})

test('the cutover write lock refuses a concurrent run insert before recording the fence', () => {
  const fixture = pendingFenceFixture('ok', true)
  const contenderId = '88888888-8888-4888-8888-888888888888'
  const database = new Database(process.env.ORCH_DB!, { readwrite: true, create: false })
  const contender = new Database(process.env.ORCH_DB!, { readwrite: true, create: false })
  contender.exec('PRAGMA busy_timeout = 0')
  let attempted = false
  try {
    applyMigrations(database, undefined, {
      migration: FENCE,
      action(locked) {
        expect(() =>
          contender
            .query(
              `INSERT INTO run
               (record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
               VALUES (?,datetime('now'),'codex','cutover-contender','sha',0,'','running')`,
            )
            .run(contenderId),
        ).toThrow('database is locked')
        attempted = true
        applyRunFilesystemIdentityCutover(locked)
      },
    })
  } finally {
    contender.close()
    database.close()
  }
  expect(attempted).toBeTrue()
  expect(fenceApplied()).toBeTrue()
  expect(existsSync(join(PRELOAD_RUNS, String(fixture.id)))).toBeFalse()
  expect(existsSync(join(PRELOAD_RUNS, fixture.recordId))).toBeTrue()
  expect(
    inspectStore((store) => store.query('SELECT 1 FROM run WHERE record_id=?').get(contenderId)),
  ).toBeNull()
})

test('a populated pre-0117 store reaches the fence before filesystem discovery', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-pre-0117-cutover-'))
  fixturePaths.push(root)
  const legacy = new Database(join(root, 'orch.db'), { create: true })
  try {
    applyMigrationsBefore(legacy, '0117_project_uuid_key')
    const recordId = randomUUID()
    const id = Number(
      legacy
        .query(
          `INSERT INTO run
           (record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
           VALUES (?,datetime('now'),'codex','pre-0117-fixture','sha',0,'','ok')`,
        )
        .run(recordId).lastInsertRowid,
    )
    const numericPath = join(PRELOAD_RUNS, String(id))
    const uuidPath = join(PRELOAD_RUNS, recordId)
    fixturePaths.push(numericPath, uuidPath)
    mkdirSync(numericPath, { recursive: true })
    applyMigrations(legacy, undefined, {
      migration: FENCE,
      action(locked) {
        applyRunFilesystemIdentityCutover(locked)
      },
    })
    expect(existsSync(numericPath)).toBeFalse()
    expect(existsSync(uuidPath)).toBeTrue()
    expect(migrationApplied(legacy, FENCE)).toBeTrue()
  } finally {
    legacy.close()
  }
})

test('pending conversion with a live run changes neither files nor schema', async () => {
  const fixture = pendingFenceFixture('asking', false)
  await expect(migrateCommand({ log: () => {} })).rejects.toThrow(
    'wait for it to finish or stop it',
  )
  expect(existsSync(join(PRELOAD_RUNS, String(fixture.id)))).toBeFalse()
  expect(existsSync(join(PRELOAD_RUNS, fixture.recordId))).toBeFalse()
  expect(fenceApplied()).toBeFalse()
})

test('unmapped-only residue is reported once and the fence advances', async () => {
  pendingFenceFixture('ok', false)
  const unknown = join(PRELOAD_RUNS, '999999999')
  fixturePaths.push(unknown)
  mkdirSync(unknown, { recursive: true })
  const first: string[] = []
  await migrateCommand({ log: (line) => first.push(line) })
  expect(first.some((line) => line.includes(`left: ${unknown}: no run 999999999`))).toBeTrue()
  expect(existsSync(unknown)).toBeTrue()
  expect(fenceApplied()).toBeTrue()

  const second: string[] = []
  await migrateCommand({ log: (line) => second.push(line) })
  expect(second.some((line) => line.includes('left:'))).toBeFalse()
  expect(existsSync(unknown)).toBeTrue()
})

test('an unreadable repository leaves the fence pending until the repository is readable', async () => {
  const fixture = pendingFenceFixture('ok', true)
  const root = mkdtempSync(join(tmpdir(), 'orch-unreadable-repository-'))
  fixturePaths.push(root)
  const savedGit = join(root, '.git-readable')
  mkdirSync(join(savedGit, 'objects'), { recursive: true })
  mkdirSync(join(savedGit, 'refs', 'heads'), { recursive: true })
  writeFileSync(join(savedGit, 'HEAD'), 'ref: refs/heads/main\n')
  writeFileSync(join(savedGit, 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = false\n')
  const database = new Database(process.env.ORCH_DB!, { readwrite: true, create: false })
  try {
    database
      .query(
        `INSERT INTO project(record_id,name,path,canon,settings)
         VALUES (?,?,?,?,?)`,
      )
      .run(randomUUID(), `unreadable-${randomUUID()}`, root, 1, '{}')
  } finally {
    database.close()
  }

  writeFileSync(join(root, '.git'), 'gitdir: /definitely/missing/orch-test-git-dir\n')

  await expect(migrateCommand({ log: () => {} })).rejects.toThrow('retained refs could not be read')
  expect(fenceApplied()).toBeFalse()
  expect(existsSync(join(PRELOAD_RUNS, String(fixture.id)))).toBeTrue()
  expect(existsSync(join(PRELOAD_RUNS, fixture.recordId))).toBeFalse()

  rmSync(join(root, '.git'))
  renameSync(savedGit, join(root, '.git'))
  await migrateCommand({ log: () => {} })
  expect(fenceApplied()).toBeTrue()
  expect(existsSync(join(PRELOAD_RUNS, String(fixture.id)))).toBeFalse()
  expect(existsSync(join(PRELOAD_RUNS, fixture.recordId))).toBeTrue()
})

test('completed conversion with live runs advances schema without file work', async () => {
  const fixture = pendingFenceFixture('asking', false, false)
  await migrateCommand({ log: () => {} })
  expect(existsSync(join(PRELOAD_RUNS, String(fixture.id)))).toBeFalse()
  expect(existsSync(join(PRELOAD_RUNS, fixture.recordId))).toBeFalse()
  expect(fenceApplied()).toBeTrue()
})

test('linked-worktree refusal leaves pending files and the store untouched', async () => {
  const fixture = pendingFenceFixture('ok', true)
  const beforeRunCount = inspectStore(
    (database) =>
      database.query<{ count: number }, []>('SELECT COUNT(*) count FROM run').get()!.count,
  )
  await expect(
    migrateCommand({ log: () => {} }, undefined, {
      authorityRefusal: () => 'refusing to migrate the store from a linked-worktree binary',
    }),
  ).rejects.toThrow('linked-worktree binary')
  expect(existsSync(join(PRELOAD_RUNS, String(fixture.id)))).toBeTrue()
  expect(existsSync(join(PRELOAD_RUNS, fixture.recordId))).toBeFalse()
  expect(fenceApplied()).toBeFalse()
  expect(
    inspectStore(
      (database) =>
        database.query<{ count: number }, []>('SELECT COUNT(*) count FROM run').get()!.count,
    ),
  ).toBe(beforeRunCount)
})
