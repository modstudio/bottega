import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { PRELOAD_RUNS } from '../../test/preload.ts'
import type { MigrationInFlightRun } from '../run/migration-in-flight-runs.ts'
import { acquireRunLease, removeFreeRunLease } from '../run/run-lease.ts'
import { applyRunFilesystemIdentityCutover, migrateCommand } from './database-commands.ts'
import { closeDatabaseForFixture, db } from './db.ts'
import type { MigrationDrainDecision } from './migration-drain-decision.ts'
import { migrationDrain } from './migration-drain-state.ts'
import {
  applyMigrations,
  applyMigrationsBefore,
  migrationApplied,
  migrationJournal,
} from './migrations.ts'
import { fixtureProjectRecordId } from './test-database.fixture.ts'

function actions(fill: () => Promise<unknown>, contracted = false) {
  const calls: string[] = []
  return {
    calls,
    value: {
      async inFlightRuns() {
        calls.push('in-flight')
        return [] as MigrationInFlightRun[]
      },
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
      migrationDecision: (): MigrationDrainDecision => ({ action: 'apply-now' }),
      withMigrationWindow: undefined as
        | ((action: () => Promise<void>) => Promise<void>)
        | undefined,
      recordOverride(reason: string) {
        calls.push(`override:${reason}`)
      },
    },
  }
}

test('migrate contracts only after identity fill succeeds', async () => {
  const scenario = actions(async () => undefined)
  await migrateCommand({ log: () => {} }, scenario.value)
  expect(scenario.calls).toEqual([
    'in-flight',
    'contracted',
    'before:0115_project_identity_contract',
    'fill',
    'before:0121_run_filesystem_identity_cutover',
    'after',
    'backfill',
  ])
})

test('an apply-now migrate runs inside the store-open migration window', async () => {
  const scenario = actions(async () => undefined)
  scenario.value.withMigrationWindow = async (action) => {
    scenario.calls.push('window:set')
    try {
      await action()
    } finally {
      scenario.calls.push('window:clear')
    }
  }
  await migrateCommand({ log: () => {} }, scenario.value)
  expect(scenario.calls).toEqual([
    'window:set',
    'in-flight',
    'contracted',
    'before:0115_project_identity_contract',
    'fill',
    'before:0121_run_filesystem_identity_cutover',
    'after',
    'backfill',
    'window:clear',
  ])
})

test('migrate stops before contraction when configured hosting refuses the fill', async () => {
  const scenario = actions(async () => {
    throw new Error(`hosted record unreachable; cleared by: ${PLATFORM_SLUG} record doctor`)
  })
  await expect(migrateCommand({ log: () => {} }, scenario.value)).rejects.toThrow(
    `cleared by: ${PLATFORM_SLUG} record doctor`,
  )
  expect(scenario.calls).toEqual([
    'in-flight',
    'contracted',
    'before:0115_project_identity_contract',
    'fill',
  ])
})

test('migrate skips the boundary and fill when the identity contract is recorded', async () => {
  const scenario = actions(async () => {
    throw new Error('fill must not run')
  }, true)
  await migrateCommand({ log: () => {} }, scenario.value)
  expect(scenario.calls).toEqual([
    'in-flight',
    'contracted',
    'before:0121_run_filesystem_identity_cutover',
    'after',
    'backfill',
  ])
})

test('migrate refuses a non-additive pending range under live runs unless explicitly forced', async () => {
  const run = {
    name: 'run-live',
    status: 'running' as const,
    waiting: false,
    holderPid: 4321,
    kind: 'run-lease' as const,
  }
  const refused = actions(async () => undefined, true)
  refused.value.inFlightRuns = async () => [run]
  refused.value.migrationDecision = () => ({ action: 'fence', migration: '0155_rebuild' })
  await expect(migrateCommand({ log: () => {} }, refused.value)).rejects.toThrow(
    `run-live (running, holder pid 4321)\ncleared by: ${PLATFORM_SLUG} machine update`,
  )

  const forced = actions(async () => undefined, true)
  forced.value.inFlightRuns = async () => [run]
  forced.value.migrationDecision = refused.value.migrationDecision
  const lines: string[] = []
  await migrateCommand({ log: (line) => lines.push(line) }, forced.value, {
    forceInFlight: 'emergency maintenance',
    fromOperator: true,
  })
  expect(lines).toContain(
    'forcing migration; these orchestrator runs will fail: run-live (running, holder pid 4321)',
  )
  expect(forced.calls).toContain('override:emergency maintenance')
})

test('the in-flight override requires operator attribution and is unavailable to workers', async () => {
  const scenario = actions(async () => undefined, true)
  await expect(
    migrateCommand({ log: () => {} }, scenario.value, { forceInFlight: 'because' }),
  ).rejects.toThrow('--from-operator')
  const prior = process.env.BOTTEGA_DEPTH
  process.env.BOTTEGA_DEPTH = '1'
  try {
    await expect(
      migrateCommand({ log: () => {} }, scenario.value, {
        forceInFlight: 'because',
        fromOperator: true,
      }),
    ).rejects.toThrow('BOTTEGA_DEPTH is set')
  } finally {
    if (prior === undefined) delete process.env.BOTTEGA_DEPTH
    else process.env.BOTTEGA_DEPTH = prior
  }
})

test('default migrate fences before sampling a held run lease', async () => {
  fixtureProjectRecordId(db())
  const database = db()
  const journal = migrationJournal()
  const pendingIndex = journal.findLastIndex((entry) => entry.compatibility !== 'additive')
  const pending = journal[pendingIndex]!
  const held = journal.slice(pendingIndex).map((entry) => ({
    entry,
    applied: database
      .query<{ hash: string; created_at: number; version: string | null }, [number]>(
        'SELECT hash,created_at,version FROM orch_migrations WHERE created_at=?',
      )
      .get(entry.when)!,
  }))
  for (const { entry } of held) {
    database.query('DELETE FROM orch_migrations WHERE created_at=?').run(entry.when)
  }
  const runId = randomUUID()
  database
    .query(
      `INSERT INTO run
       (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,pid,project_record_id)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM run),datetime('now'),'codex','migration-fence','sha',0,'','ok',?,
               (SELECT record_id FROM project ORDER BY name LIMIT 1))`,
    )
    .run(runId, process.pid)
  const lease = acquireRunLease(runId)
  let drainAtRunReport: ReturnType<typeof migrationDrain> | undefined
  try {
    const presentation = {
      log(line: string) {
        if (line.startsWith('runs in flight before migration:') && !drainAtRunReport) {
          drainAtRunReport = migrationDrain(db())
        }
      },
    }
    await expect(migrateCommand(presentation)).rejects.toThrow(
      `${runId} (ok, holder pid ${process.pid})`,
    )
    expect(drainAtRunReport).toMatchObject({ phase: 'migrating', migration: pending.tag })
    await expect(migrateCommand(presentation)).rejects.toThrow(
      `cleared by: ${PLATFORM_SLUG} machine update`,
    )
    expect(migrationDrain(db())).toBeNull()
  } finally {
    lease.release()
    removeFreeRunLease(runId)
    database.query('DELETE FROM run WHERE record_id=?').run(runId)
    for (const { applied } of held) {
      database
        .query('INSERT OR REPLACE INTO orch_migrations(hash,created_at,version) VALUES (?,?,?)')
        .run(applied.hash, applied.created_at, applied.version)
    }
  }
})

const FENCE = '0121_run_filesystem_identity_cutover'
const fixturePaths: string[] = []

afterEach(() => {
  for (const path of fixturePaths.splice(0)) rmSync(path, { recursive: true, force: true })
})

function inspectStore<T>(read: (database: Database) => T): T {
  closeDatabaseForFixture()
  const database = new Database(process.env.BOTTEGA_ORCHESTRATOR_DB!, {
    readwrite: true,
    create: false,
  })
  try {
    return read(database)
  } finally {
    database.close()
  }
}

const fenceApplied = (): boolean => inspectStore((database) => migrationApplied(database, FENCE))

function pendingFenceFixture(status: 'ok' | 'asking', numericFolder: boolean, deleteFence = true) {
  const database = db()
  fixtureProjectRecordId(database)
  const fence = migrationJournal().find((entry) => entry.tag === FENCE)!
  if (deleteFence) database.query('DELETE FROM orch_migrations WHERE created_at=?').run(fence.when)
  database.run(
    "UPDATE run SET status='ok' WHERE status IN ('reserved','attached','running','asking')",
  )
  const recordId = randomUUID()
  database
    .query(
      `INSERT INTO run
       (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,project_record_id)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM run),datetime('now'),'codex','migration-fixture','sha',0,'',?,
               (SELECT record_id FROM project ORDER BY name LIMIT 1))`,
    )
    .run(recordId, status)
  const id = database
    .query<{ number: number }, [string]>('SELECT number FROM run WHERE record_id=?')
    .get(recordId)!.number
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
  const database = new Database(process.env.BOTTEGA_ORCHESTRATOR_DB!, {
    readwrite: true,
    create: false,
  })
  const contender = new Database(process.env.BOTTEGA_ORCHESTRATOR_DB!, {
    readwrite: true,
    create: false,
  })
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
  const legacy = new Database(join(root, 'orchestrator.db'), { create: true })
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
    `cleared by: ${PLATFORM_SLUG} machine update`,
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
  const database = new Database(process.env.BOTTEGA_ORCHESTRATOR_DB!, {
    readwrite: true,
    create: false,
  })
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
