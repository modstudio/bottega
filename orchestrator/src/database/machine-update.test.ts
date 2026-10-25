import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { dir } from '../../test/fixtures/store.ts'
import { acquireRunLease, removeFreeRunLease } from '../run/run-lease.ts'
import { db } from './db.ts'
import { machineUpdateCommand } from './machine-update.ts'
import { migrationDrain, setMigrationDrain } from './migration-drain.ts'
import { migrationJournal } from './migrations.ts'
import { fixtureProjectRecordId } from './test-database.fixture.ts'

function holdBackLastNonAdditiveMigration(database: ReturnType<typeof db>) {
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
  return {
    pending,
    restore() {
      for (const { applied } of held) {
        database
          .query('INSERT OR REPLACE INTO orch_migrations(hash,created_at,version) VALUES (?,?,?)')
          .run(applied.hash, applied.created_at, applied.version)
      }
    },
  }
}

test("machine update clears a dead holder's marker before deciding", async () => {
  setMigrationDrain(db(), '0155_rebuild', 'draining', {
    pid: 4_200_000,
    startTime: 'old birth',
  })
  const gitCalls: string[][] = []
  let migrated = false
  await machineUpdateCommand(
    { log: () => {} },
    {
      cwd: dir,
      authorityRefusal: () => null,
      project: () => ({ name: 'migration-update-fixture', path: dir, settings: { trunk: 'main' } }),
      git: (_cwd, args) => {
        gitCalls.push(args)
        if (args[0] === 'branch') return 'main'
        return args[0] === 'show' ? JSON.stringify({ entries: migrationJournal() }) : ''
      },
      migrate: () => {
        migrated = true
      },
    },
  )
  expect(migrationDrain(db())).toBeNull()
  expect(migrated).toBe(true)
  expect(gitCalls.map((args) => args[0])).toEqual(['branch', 'fetch', 'show', 'pull'])
})

test('a non-additive update waits for an admitted resume, then migrates behind the fence', async () => {
  const database = db()
  fixtureProjectRecordId(database)
  const held = holdBackLastNonAdditiveMigration(database)
  const pending = held.pending
  const events: string[] = []
  const lines: string[] = []
  const runId = randomUUID()
  const resumeId = randomUUID()
  database
    .query(
      `INSERT INTO run
       (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,project_record_id)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM run),datetime('now'),'codex','migration-fixture','sha',0,'','ok',
               (SELECT record_id FROM project ORDER BY name LIMIT 1))`,
    )
    .run(runId)
  const lease = acquireRunLease(runId)
  let released = false
  let sleeps = 0
  try {
    await machineUpdateCommand(
      { log: (line) => lines.push(line) },
      {
        cwd: dir,
        authorityRefusal: () => null,
        project: () => ({
          name: 'migration-update-fixture',
          path: dir,
          settings: { trunk: 'main' },
        }),
        git: (_cwd, args) => {
          if (args[0] === 'branch') return 'main'
          if (args[0] === 'show') return JSON.stringify({ entries: migrationJournal() })
          if (args[0] === 'pull') {
            expect(migrationDrain(db())?.migration).toBe(pending.tag)
            events.push('pull')
          }
          return ''
        },
        sleep: async () => {
          sleeps += 1
          if (sleeps === 1) {
            lease.release()
            released = true
          } else {
            database.query("UPDATE run SET status='ok' WHERE record_id=?").run(resumeId)
            events.push('resume-finished')
          }
        },
        afterDrainPromoted: () => {
          if (database.query('SELECT record_id FROM run WHERE record_id=?').get(resumeId)) return
          database
            .query(
              `INSERT INTO run
               (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,project_record_id)
               VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM run),datetime('now'),'codex','migration-resume','sha',0,'','running',
                       (SELECT record_id FROM project ORDER BY name LIMIT 1))`,
            )
            .run(resumeId)
          events.push('resume-admitted')
        },
        migrate: () => {
          expect(migrationDrain(db())?.phase).toBe('migrating')
          events.push('migrate')
        },
      },
    )
  } finally {
    if (!released) lease.release()
    removeFreeRunLease(runId)
    database.query('DELETE FROM run WHERE record_id=?').run(resumeId)
    held.restore()
  }
  expect(events).toEqual(['resume-admitted', 'resume-finished', 'pull', 'migrate'])
  expect(lines).toContain(
    `draining for migration ${pending.tag}; waiting on ${runId} (ok, holder pid unknown)`,
  )
  expect(lines).toContain(`draining for migration ${pending.tag}; waiting on ${resumeId} (running)`)
  expect(migrationDrain(db())).toBeNull()
})

test('machine update clears the drain marker when the bounded wait expires', async () => {
  const database = db()
  fixtureProjectRecordId(database)
  const held = holdBackLastNonAdditiveMigration(database)
  const runId = randomUUID()
  database
    .query(
      `INSERT INTO run
       (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,pid,project_record_id)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM run),datetime('now'),'codex','migration-bound','sha',0,'','ok',?,
               (SELECT record_id FROM project ORDER BY name LIMIT 1))`,
    )
    .run(runId, process.pid)
  const lease = acquireRunLease(runId)
  let nowCalls = 0
  try {
    await expect(
      machineUpdateCommand(
        { log: () => {} },
        {
          cwd: dir,
          authorityRefusal: () => null,
          project: () => ({
            name: 'migration-update-fixture',
            path: dir,
            settings: { trunk: 'main' },
          }),
          git: (_cwd, args) => {
            if (args[0] === 'branch') return 'main'
            return args[0] === 'show' ? JSON.stringify({ entries: migrationJournal() }) : ''
          },
          now: () => (nowCalls++ === 0 ? 0 : Number.MAX_SAFE_INTEGER),
          sleep: async () => {},
        },
      ),
    ).rejects.toThrow(
      `${PLATFORM_SLUG} machine migrate --force-in-flight "<reason>" --from-operator`,
    )
    expect(migrationDrain(db())).toBeNull()
  } finally {
    lease.release()
    removeFreeRunLease(runId)
    database.query('DELETE FROM run WHERE record_id=?').run(runId)
    held.restore()
  }
})

test('machine update refuses a live drain with its holder named', async () => {
  setMigrationDrain(db(), '0155_rebuild', 'draining', {
    pid: process.pid,
    startTime: null,
  })
  try {
    await expect(
      machineUpdateCommand(
        { log: () => {} },
        {
          cwd: dir,
          authorityRefusal: () => null,
          project: () => ({
            name: 'migration-update-fixture',
            path: dir,
            settings: { trunk: 'main' },
          }),
          git: (_cwd, args) =>
            args[0] === 'branch'
              ? 'main'
              : args[0] === 'show'
                ? JSON.stringify({ entries: migrationJournal() })
                : '',
        },
      ),
    ).rejects.toThrow(`holder pid ${process.pid}`)
  } finally {
    db().query("DELETE FROM schema_meta WHERE key='migration_drain'").run()
  }
})

test('machine update requires the registered landing branch in the main checkout', async () => {
  await expect(
    machineUpdateCommand(
      { log: () => {} },
      {
        cwd: dir,
        authorityRefusal: () => null,
        project: () => ({
          name: 'migration-update-fixture',
          path: dir,
          settings: { trunk: 'main' },
        }),
        git: (_cwd, args) => (args[0] === 'branch' ? 'release' : ''),
      },
    ),
  ).rejects.toThrow(`registered landing branch is main, but ${dir} is on release; check out main`)
})

test('machine update refuses the BOTTEGA_ORCHESTRATOR_DB override', async () => {
  await expect(machineUpdateCommand({ log: () => {} })).rejects.toThrow(
    'refusing machine update through BOTTEGA_ORCHESTRATOR_DB',
  )
})
