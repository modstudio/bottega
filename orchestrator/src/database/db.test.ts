import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import {
  closeDatabaseForFixture,
  DB_PATH,
  db,
  registerOpenHooks,
  withReadOnlyDatabaseAccess,
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
  const seed = new Database(DB_PATH, { readwrite: true, create: false })
  try {
    seed.exec(`
      CREATE TABLE __orch_write_probe_999999 (value INTEGER);
      CREATE TABLE "${liveProbe}" (value INTEGER);
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
