import { afterAll, beforeAll, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PLATFORM_NAME, PLATFORM_SLUG } from '../../../shared/brand.ts'
import { DIST_MANIFEST, INSTALL_HOME_ENV, installRoot } from '../../../shared/install-root.ts'
import { dir } from '../../test/fixtures/store.ts'
import { acquireRunLease, removeFreeRunLease } from '../run/run-lease.ts'
import { db } from './db.ts'
import { machineUpdateCommand, unregisteredMainCheckoutRefusal } from './machine-update.ts'
import { setMigrationDrain } from './migration-drain.ts'
import { migrationDrain } from './migration-drain-state.ts'
import { ORCHESTRATOR_MIGRATION_JOURNAL_SOURCE } from './migration-journal-sources.ts'
import { migrationWindow } from './migration-window-state.ts'
import { migrationJournal } from './migrations.ts'
import { fixtureProjectRecordId } from './test-database.fixture.ts'

const fixturePackage = join(dir, 'package.json')

beforeAll(() => {
  writeFileSync(fixturePackage, JSON.stringify({ name: PLATFORM_SLUG }))
})

afterAll(() => {
  rmSync(fixturePackage, { force: true })
})

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

function holdBackLastAdditiveMigration(database: ReturnType<typeof db>) {
  const journal = migrationJournal()
  const pendingIndex = journal.findLastIndex((entry) => entry.compatibility === 'additive')
  const held = journal.slice(pendingIndex, pendingIndex + 1).map((entry) => ({
    entry,
    applied: database
      .query<{ hash: string; created_at: number; version: string | null }, [number]>(
        'SELECT hash,created_at,version FROM orch_migrations WHERE created_at=?',
      )
      .get(entry.when)!,
  }))
  expect(held.length).toBeGreaterThan(0)
  expect(held.every(({ entry }) => entry.compatibility === 'additive')).toBe(true)
  for (const { entry } of held) {
    database.query('DELETE FROM orch_migrations WHERE created_at=?').run(entry.when)
  }
  return {
    pending: held[0]!.entry,
    journal: journal.slice(0, pendingIndex + 1),
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
      runLaunchAgentsRefreshVerb: () => {},
    },
  )
  expect(migrationDrain(db())).toBeNull()
  expect(migrated).toBe(true)
  expect(gitCalls.map((args) => args[0])).toEqual([
    'branch',
    'fetch',
    'show',
    'pull',
    'branch',
    'status',
  ])
})

test('machine update refuses when the install root is tracked-dirty after refresh', async () => {
  let refreshed = false
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
          if (args[0] === 'show') return JSON.stringify({ entries: migrationJournal() })
          if (args[0] === 'status') return ' M tracked.ts'
          return ''
        },
        migrate: () => {},
        runLaunchAgentsRefreshVerb: () => {
          refreshed = true
        },
      },
    ),
  ).rejects.toThrow('checkout has tracked modifications')
  expect(refreshed).toBe(true)
})

test('an additive machine update marks only the store-open window around pull and migrate', async () => {
  const held = holdBackLastAdditiveMigration(db())
  const phases: string[] = []
  try {
    await machineUpdateCommand(
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
          if (args[0] === 'show') return JSON.stringify({ entries: held.journal })
          if (args[0] === 'pull') {
            expect(migrationWindow(db())?.migration).toBe(held.pending.tag)
            expect(migrationDrain(db())).toBeNull()
            phases.push('pull')
          }
          return ''
        },
        migrate: () => {
          expect(migrationWindow(db())?.migration).toBe(held.pending.tag)
          expect(migrationDrain(db())).toBeNull()
          phases.push('migrate')
        },
        runLaunchAgentsRefreshVerb: () => {},
      },
    )
    expect(phases).toEqual(['pull', 'migrate'])
    expect(migrationWindow(db())).toBeNull()
    expect(migrationDrain(db())).toBeNull()
  } finally {
    held.restore()
  }
})

test('an additive machine update clears the store-open window when migrate throws', async () => {
  const held = holdBackLastAdditiveMigration(db())
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
                ? JSON.stringify({ entries: held.journal })
                : '',
          migrate: () => {
            expect(migrationWindow(db())?.migration).toBe(held.pending.tag)
            expect(migrationDrain(db())).toBeNull()
            throw new Error('injected migration failure')
          },
        },
      ),
    ).rejects.toThrow('injected migration failure')
    expect(migrationWindow(db())).toBeNull()
    expect(migrationDrain(db())).toBeNull()
  } finally {
    held.restore()
  }
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
        runLaunchAgentsRefreshVerb: () => {},
      },
    )
  } finally {
    if (!released) lease.release()
    removeFreeRunLease(runId)
    database.query('DELETE FROM run WHERE record_id=?').run(resumeId)
    held.restore()
  }
  expect(events).toEqual(['resume-admitted', 'resume-finished', 'pull', 'migrate'])
  expect(lines.some((line) => line.includes(`waiting on ${runId} (ok, holder pid unknown)`))).toBe(
    true,
  )
  expect(
    lines.some((line) => line.includes(`waiting on ${resumeId} (running, holder pid unknown)`)),
  ).toBe(true)
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
  let applied = false
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
            if (args[0] === 'pull') applied = true
            return args[0] === 'show' ? JSON.stringify({ entries: migrationJournal() }) : ''
          },
          migrate: () => {
            applied = true
          },
          now: () => (nowCalls++ === 0 ? 0 : Number.MAX_SAFE_INTEGER),
          sleep: async () => {},
        },
      ),
    ).rejects.toThrow(
      `${PLATFORM_SLUG} machine migrate --force-in-flight "<reason>" --from-operator`,
    )
    expect(applied).toBe(false)
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

test('machine update refuses a version argument for a checkout', async () => {
  await expect(
    machineUpdateCommand({ log: () => {} }, { authorityRefusal: () => null }, 'v1.2.3'),
  ).rejects.toThrow(
    `a checkout updates to its registered landing branch; run ${PLATFORM_SLUG} machine update`,
  )
})

test('machine update refuses an installation that is not a registered main checkout', async () => {
  await expect(
    machineUpdateCommand(
      { log: () => {} },
      {
        cwd: dir,
        authorityRefusal: () => null,
        project: () => null,
      },
    ),
  ).rejects.toThrow(
    `refusing machine update: this installation's root ${dir} is not a registered main checkout; run the registered main checkout's bin/${PLATFORM_SLUG} machine update, or unset ${INSTALL_HOME_ENV} if it points elsewhere`,
  )
})

test('machine update chooses the running checkout when install home names a distribution', async () => {
  const designated = mkdtempSync(join(tmpdir(), 'machine-update-designated-release.'))
  const previous = process.env[INSTALL_HOME_ENV]
  writeFileSync(
    join(designated, DIST_MANIFEST),
    JSON.stringify({
      name: PLATFORM_NAME,
      version: '1.2.3',
      built: '2026-11-05T12:00:00.000Z',
      commit: 'abc1234',
    }),
  )
  process.env[INSTALL_HOME_ENV] = designated
  try {
    await expect(
      machineUpdateCommand(
        { log: () => {} },
        { authorityRefusal: () => null, project: () => null },
      ),
    ).rejects.toThrow(
      `refusing machine update: this installation's root ${designated} is not a registered main checkout`,
    )
  } finally {
    if (previous === undefined) delete process.env[INSTALL_HOME_ENV]
    else process.env[INSTALL_HOME_ENV] = previous
    rmSync(designated, { recursive: true, force: true })
  }
})

test('unregistered main checkout refusal names the registered binary when the register has one', () => {
  const same = (left: string, right: string) => left === right
  expect(unregisteredMainCheckoutRefusal('/install', null, same)).toBe(
    `refusing machine update: this installation's root /install is not a registered main checkout; run the registered main checkout's bin/${PLATFORM_SLUG} machine update, or unset ${INSTALL_HOME_ENV} if it points elsewhere`,
  )
  expect(unregisteredMainCheckoutRefusal('/install', { path: '/registered-main' }, same)).toBe(
    `refusing machine update: this installation's root /install is not a registered main checkout; run /registered-main/bin/${PLATFORM_SLUG} machine update, or unset ${INSTALL_HOME_ENV} if it points elsewhere`,
  )
  expect(unregisteredMainCheckoutRefusal('/install', { path: '/install' }, same)).toBeNull()
})

test(`machine update targets the ${PLATFORM_NAME} checkout when the caller is another project`, async () => {
  const target = dir
  const caller = resolve(dir, 'other-project')
  const projectPaths: string[] = []
  const gitCwds: string[] = []
  const lines: string[] = []
  await machineUpdateCommand(
    { log: (line) => lines.push(line) },
    {
      cwd: target,
      callerCwd: caller,
      authorityRefusal: () => null,
      project: (cwd) => {
        projectPaths.push(cwd)
        return { name: PLATFORM_SLUG, path: target, settings: { trunk: 'main' } }
      },
      git: (cwd, args) => {
        gitCwds.push(cwd)
        if (args[0] === 'branch') return 'main'
        return args[0] === 'show' ? JSON.stringify({ entries: migrationJournal() }) : ''
      },
      migrate: () => {},
      runLaunchAgentsRefreshVerb: () => {},
    },
  )
  expect(lines[0]).toBe(`updating the ${PLATFORM_NAME} checkout at ${target}`)
  expect(lines[1]).toBe('outbox released 0 payloads; backlog remains no')
  expect(lines[2]).toMatch(
    /^incremental vacuum setup: pruned 0 rows, \d+ bytes before, \d+ bytes after, \d+ms elapsed$/,
  )
  expect(projectPaths).toEqual([target])
  expect(gitCwds).toEqual([target, target, target, target, target, target])
})

test('machine update defaults the target to the installation root', async () => {
  const target = installRoot()
  const projectPaths: string[] = []
  const gitCwds: string[] = []
  let journalRef = ''
  await machineUpdateCommand(
    { log: () => {} },
    {
      callerCwd: resolve(dir, 'other-project'),
      authorityRefusal: () => null,
      project: (cwd) => {
        projectPaths.push(cwd)
        return { name: PLATFORM_SLUG, path: target, settings: { trunk: 'main' } }
      },
      git: (cwd, args) => {
        gitCwds.push(cwd)
        if (args[0] === 'branch') return 'main'
        if (args[0] === 'show') {
          journalRef = args[1] ?? ''
          return JSON.stringify({ entries: migrationJournal() })
        }
        return ''
      },
      migrate: () => {},
      runLaunchAgentsRefreshVerb: () => {},
    },
  )
  expect(projectPaths).toEqual([target])
  expect(gitCwds).toEqual([target, target, target, target, target, target])
  expect(journalRef).toBe(`origin/main:${ORCHESTRATOR_MIGRATION_JOURNAL_SOURCE.path}`)
})

test('machine update does not name the checkout when the caller is already there', async () => {
  const lines: string[] = []
  await machineUpdateCommand(
    { log: (line) => lines.push(line) },
    {
      cwd: dir,
      callerCwd: dir,
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
      migrate: () => {},
      runLaunchAgentsRefreshVerb: () => {},
    },
  )
  expect(lines).toHaveLength(2)
  expect(lines[0]).toBe('outbox released 0 payloads; backlog remains no')
  expect(lines[1]).toMatch(
    /^incremental vacuum setup: pruned 0 rows, \d+ bytes before, \d+ bytes after, \d+ms elapsed$/,
  )
})

test('machine update keeps its successful result when store maintenance fails', async () => {
  const lines: string[] = []
  await expect(
    machineUpdateCommand(
      { log: (line) => lines.push(line) },
      {
        cwd: dir,
        callerCwd: dir,
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
        migrate: () => {},
        maintainStore: () => {
          throw new Error('store busy')
        },
        runLaunchAgentsRefreshVerb: () => {},
      },
    ),
  ).resolves.toBeUndefined()
  expect(lines).toEqual([
    `incremental vacuum setup skipped: store busy; retry with ${PLATFORM_SLUG} machine update`,
  ])
})

test('checkout update refreshes through deps.cwd when the running identity root differs', async () => {
  const target = mkdtempSync(join(tmpdir(), 'machine-update-checkout.'))
  const refreshed: string[] = []
  writeFileSync(join(target, 'package.json'), JSON.stringify({ name: PLATFORM_SLUG }))
  try {
    await machineUpdateCommand(
      { log: () => {} },
      {
        cwd: target,
        identity: {
          kind: 'checkout',
          root: join(target, 'running-checkout'),
          version: 'development',
        },
        authorityRefusal: () => null,
        project: () => ({
          name: 'migration-update-fixture',
          path: target,
          settings: { trunk: 'main' },
        }),
        git: (_cwd, args) =>
          args[0] === 'branch'
            ? 'main'
            : args[0] === 'show'
              ? JSON.stringify({ entries: migrationJournal() })
              : '',
        migrate: () => {},
        maintainStore: () => {},
        runLaunchAgentsRefreshVerb: (binary) => refreshed.push(binary),
      },
    )
    expect(refreshed).toEqual([resolve(target, 'bin', PLATFORM_SLUG)])
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('distribution update refreshes through the installed target and preserves its remedy failure', async () => {
  const target = realpathSync(process.execPath)
  const refreshed: string[] = []
  let updated = false
  const remedy = `com.user.orch-record-sync definition still drifted; run ${PLATFORM_SLUG} machine setup apply`
  await expect(
    machineUpdateCommand(
      { log: () => {} },
      {
        authorityRefusal: () => null,
        identity: {
          kind: 'distribution',
          root: resolve(target, '..'),
          manifest: {
            name: PLATFORM_NAME,
            version: '1.2.3',
            built: '2026-11-06T12:00:00.000Z',
            commit: 'abc1234',
          },
        },
        updateDistribution: async () => {
          updated = true
        },
        maintainStore: () => {},
        runLaunchAgentsRefreshVerb: (binary) => {
          refreshed.push(binary)
          throw new Error(remedy)
        },
      },
    ),
  ).rejects.toThrow(remedy)
  expect(updated).toBeTrue()
  expect(refreshed).toEqual([target])
})
