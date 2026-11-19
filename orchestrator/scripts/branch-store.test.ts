import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { applyMigrations, MIGRATIONS_FOLDER, migrationJournal } from '../src/database/migrations.ts'
import {
  classifyStore,
  localGateRegistrationDecision,
  migrateStore,
  probeLocalGateRegistration,
  snapshotStore,
} from './branch-store.ts'

function writeMigrationFolder(folder: string, entries = migrationJournal().slice(0, -1)): void {
  mkdirSync(join(folder, 'meta'), { recursive: true })
  for (const entry of entries) {
    copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`))
  }
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'sqlite', entries }),
  )
}

test('classifies stores against full and truncated migration journals', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-branch-store-classify-'))
  const migrations = join(dir, 'migrations')
  const prior = join(dir, 'prior.db')
  const current = join(dir, 'current.db')
  writeMigrationFolder(migrations)

  for (const [path, folder] of [
    [prior, migrations],
    [current, MIGRATIONS_FOLDER],
  ] as const) {
    const database = new Database(path, { create: true })
    try {
      applyMigrations(database, folder)
    } finally {
      database.close()
    }
  }

  try {
    expect(classifyStore(null)).toBe('absent')
    expect(classifyStore(current)).toBe('current')
    expect(classifyStore(prior)).toBe('behind')
    expect(classifyStore(current, migrations)).toBe('ahead')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('snapshots a prior store, migrates the snapshot, and leaves the source unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-branch-store-'))
  const migrations = join(dir, 'migrations')
  const source = join(dir, 'source.db')
  const snapshots = join(dir, 'snapshots')
  mkdirSync(snapshots)
  writeMigrationFolder(migrations)

  const database = new Database(source, { create: true })
  try {
    applyMigrations(database, migrations)
  } finally {
    database.close()
  }

  try {
    expect(classifyStore(source)).toBe('behind')
    const snapshot = snapshotStore(source, snapshots)
    migrateStore(snapshot)
    expect(classifyStore(snapshot)).toBe('current')
    expect(classifyStore(source)).toBe('behind')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('local machine-state checks run for a registered checkout', () => {
  expect(
    localGateRegistrationDecision('/home/dev/Projects/bottega', { kind: 'registered' }),
  ).toEqual({ kind: 'run' })
})

test('local machine-state checks skip an unregistered checkout with the registration remedy', () => {
  const checkout = '/home/dev/Projects/bottega'
  expect(localGateRegistrationDecision(checkout, { kind: 'unregistered' })).toEqual({
    kind: 'skip',
    message: `checkout ${checkout} is not registered because the project register has no project containing this checkout; remedy: ${PLATFORM_SLUG} project add ${JSON.stringify(checkout)}`,
  })
})

test('local machine-state checks skip an absent store', () => {
  expect(
    localGateRegistrationDecision('/home/dev/Projects/bottega', { kind: 'absent-store' }),
  ).toMatchObject({
    kind: 'skip',
    message: expect.stringContaining('the orchestrator store is absent'),
  })
})

test('local machine-state checks skip a store without a project table', () => {
  expect(
    localGateRegistrationDecision('/home/dev/Projects/bottega', { kind: 'absent-register' }),
  ).toMatchObject({
    kind: 'skip',
    message: expect.stringContaining('the orchestrator store has no project register'),
  })
})

test('local machine-state checks fail when a registered checkout store is unreadable', () => {
  const checkout = '/home/dev/Projects/bottega'
  expect(
    localGateRegistrationDecision(checkout, {
      kind: 'unreadable-store',
      detail: 'permission denied',
    }),
  ).toEqual({
    kind: 'fail',
    message: `cannot read the project register for checkout ${checkout}: permission denied`,
  })
})

test('registration probe handles absent, incomplete, matching, retired, lookalike, and unreadable stores', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-registration-probe-'))
  const absent = join(dir, 'absent.db')
  const empty = join(dir, 'empty.db')
  const registered = join(dir, 'registered.db')
  const unreadable = join(dir, 'unreadable.db')
  try {
    expect(probeLocalGateRegistration('/a/b', absent)).toMatchObject({
      kind: 'unreadable-store',
    })
    const emptyDatabase = new Database(empty, { create: true })
    emptyDatabase.close()
    expect(probeLocalGateRegistration('/a/b', empty)).toEqual({ kind: 'absent-register' })

    const database = new Database(registered, { create: true })
    database.exec('CREATE TABLE project (path TEXT NOT NULL, retired_at TEXT)')
    database.query('INSERT INTO project VALUES (?, ?)').run('/exact', null)
    database.query('INSERT INTO project VALUES (?, ?)').run('/parent', null)
    database.query('INSERT INTO project VALUES (?, ?)').run('/retired', '2026-01-01')
    database.query('INSERT INTO project VALUES (?, ?)').run('/a/b', null)
    database.close()
    expect(probeLocalGateRegistration('/exact', registered)).toEqual({ kind: 'registered' })
    expect(probeLocalGateRegistration('/parent/worktree', registered)).toEqual({
      kind: 'registered',
    })
    expect(probeLocalGateRegistration('/retired', registered)).toEqual({ kind: 'unregistered' })
    expect(probeLocalGateRegistration('/a/bc', registered)).toEqual({ kind: 'unregistered' })

    writeFileSync(unreadable, 'not a sqlite database')
    expect(probeLocalGateRegistration('/a/b', unreadable)).toMatchObject({
      kind: 'unreadable-store',
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('registration skip remedy may name the main checkout instead of its worktree', () => {
  expect(
    localGateRegistrationDecision(
      '/main/.claude/worktrees/task',
      { kind: 'unregistered' },
      '/main',
    ),
  ).toMatchObject({ message: expect.stringContaining(`${PLATFORM_SLUG} project add "/main"`) })
})
