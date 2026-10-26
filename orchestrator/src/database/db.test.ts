import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import {
  checkpointAndCloseDatabase,
  closeDatabaseForFixture,
  DB_PATH,
  db,
  registerOpenHooks,
  withReadOnlyDatabaseAccess,
  writableDb,
} from './db.ts'

test('a writable open refuses when no hooks are registered', () => {
  closeDatabaseForFixture()
  const restore = registerOpenHooks({})
  try {
    expect(() => db()).toThrow(/registerStandardHooks\(\)/)
  } finally {
    restore()
  }
})

test('a read-only command neither enters writable-open hooks nor permits a write', () => {
  closeDatabaseForFixture()
  let entered = 0
  const restore = registerOpenHooks({
    afterWritableOpen: [() => entered++],
  })
  try {
    withReadOnlyDatabaseAccess(() => {
      expect(db().query('SELECT COUNT(*) AS count FROM run').get()).toBeTruthy()
      expect(() => db().query('UPDATE run SET status=status').run()).toThrow(
        'attempt to write a readonly database',
      )
    })
    expect(entered).toBe(0)
  } finally {
    restore()
    closeDatabaseForFixture()
  }
})

test('a writable open sweeps only dead write probes and leaves none for itself', () => {
  closeDatabaseForFixture()
  const liveProbe = `__orch_write_probe_${process.ppid}`
  const reusedPidProbe = `__orch_write_probe_${process.pid}`
  const seed = new Database(DB_PATH, { readwrite: true, create: false })
  try {
    seed.exec(`
      CREATE TABLE __orch_write_probe_999999 (value INTEGER);
      CREATE TABLE "${liveProbe}" (value INTEGER);
      CREATE TABLE "${reusedPidProbe}" (value INTEGER);
      CREATE TABLE __orch_write_probe_not_a_pid (value INTEGER);
      CREATE TABLE unrelated_table (value INTEGER);
    `)
  } finally {
    seed.close()
  }

  try {
    const tables = db()
      .query(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND (name LIKE '__orch_write_probe_%' OR name = 'unrelated_table')
         ORDER BY name`,
      )
      .all()
    expect(tables).toEqual(
      [
        { name: liveProbe },
        { name: '__orch_write_probe_not_a_pid' },
        { name: 'unrelated_table' },
      ].sort((left, right) => left.name.localeCompare(right.name)),
    )
  } finally {
    closeDatabaseForFixture()
  }
})

test('a failed stale-probe sweep does not make the connection read-only', () => {
  closeDatabaseForFixture()
  const seed = new Database(DB_PATH, { readwrite: true, create: false })
  try {
    seed.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE __orch_write_probe_999999 (id INTEGER PRIMARY KEY);
      CREATE TABLE probe_sweep_blocker (
        probe_id INTEGER NOT NULL REFERENCES __orch_write_probe_999999(id)
      );
      INSERT INTO __orch_write_probe_999999 (id) VALUES (1);
      INSERT INTO probe_sweep_blocker (probe_id) VALUES (1);
    `)
  } finally {
    seed.close()
  }

  let entered = 0
  const restore = registerOpenHooks({ afterWritableOpen: [() => entered++] })
  try {
    const database = db()
    expect(entered).toBe(1)
    expect(() => database.exec('UPDATE project SET name = name')).not.toThrow()
    expect(
      database
        .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get('__orch_write_probe_999999'),
    ).toBeTruthy()
  } finally {
    restore()
    closeDatabaseForFixture()
  }
})

test('a writable open leaves the WAL sidecars behind so a plain read-only open succeeds', () => {
  writableDb()
  checkpointAndCloseDatabase()
  // SQLite deletes these when the last connection closes unless that connection asked for a
  // persistent WAL, and a sidecar-less WAL store cannot be opened read-only at all.
  expect(existsSync(`${DB_PATH}-wal`)).toBeTrue()
  expect(existsSync(`${DB_PATH}-shm`)).toBeTrue()
  const reader = new Database(DB_PATH, { readonly: true })
  try {
    expect(reader.query('SELECT count(*) AS tables FROM sqlite_master').get()).toBeTruthy()
  } finally {
    reader.close()
  }
})
