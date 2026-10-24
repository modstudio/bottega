import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { dir } from '../../test/fixtures/store.ts'
import { acquireRunLease, removeFreeRunLease } from '../run/run-lease.ts'
import { db } from './db.ts'
import { machineUpdateCommand } from './machine-update.ts'
import { migrationDrain, setMigrationDrain } from './migration-drain.ts'
import { migrationJournal } from './migrations.ts'

test("machine update clears a dead holder's marker before deciding", async () => {
  setMigrationDrain(db(), '0155_rebuild', { pid: 4_200_000, startTime: 'old birth' })
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
        return args[0] === 'show' ? JSON.stringify({ entries: migrationJournal() }) : ''
      },
      migrate: () => {
        migrated = true
      },
    },
  )
  expect(migrationDrain(db())).toBeNull()
  expect(migrated).toBe(true)
  expect(gitCalls.map((args) => args[0])).toEqual(['fetch', 'show', 'pull'])
})

test('a non-additive update marks admission, waits for a lease, then pulls and clears', async () => {
  const database = db()
  const pending = migrationJournal().at(-1)!
  const applied = database
    .query<{ hash: string; created_at: number; version: string | null }, [number]>(
      'SELECT hash,created_at,version FROM orch_migrations WHERE created_at=?',
    )
    .get(pending.when)!
  database.query('DELETE FROM orch_migrations WHERE created_at=?').run(pending.when)
  const events: string[] = []
  const lines: string[] = []
  const runId = randomUUID()
  database
    .query(
      `INSERT INTO run
       (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM run),datetime('now'),'codex','migration-fixture','sha',0,'','ok')`,
    )
    .run(runId)
  const lease = acquireRunLease(runId)
  let released = false
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
          if (args[0] === 'show') return JSON.stringify({ entries: migrationJournal() })
          if (args[0] === 'pull') {
            expect(migrationDrain(db())?.migration).toBe(pending.tag)
            events.push('pull')
          }
          return ''
        },
        sleep: async () => {
          lease.release()
          released = true
          events.push('released')
        },
        migrate: () => events.push('migrate'),
      },
    )
  } finally {
    if (!released) lease.release()
    removeFreeRunLease(runId)
    database
      .query('INSERT OR REPLACE INTO orch_migrations(hash,created_at,version) VALUES (?,?,?)')
      .run(applied.hash, applied.created_at, applied.version)
  }
  expect(events).toEqual(['released', 'pull', 'migrate'])
  expect(lines).toContain(`draining for migration ${pending.tag}; waiting on ${runId} (ok)`)
  expect(migrationDrain(db())).toBeNull()
})

test('machine update refuses a live drain with its holder named', async () => {
  setMigrationDrain(db(), '0155_rebuild', { pid: process.pid, startTime: null })
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
            args[0] === 'show' ? JSON.stringify({ entries: migrationJournal() }) : '',
        },
      ),
    ).rejects.toThrow(`holder pid ${process.pid}`)
  } finally {
    db().query("DELETE FROM schema_meta WHERE key='migration_drain'").run()
  }
})
