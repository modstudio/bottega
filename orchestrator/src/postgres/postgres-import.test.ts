import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SQL } from 'bun'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId, PLATFORM_SPACE_ID, project } from '../../../shared/record/schema.ts'
import { installRecordApiClient } from '../../test/fixtures/record-api.ts'
import {
  installRecordSessionRunner,
  memoryRecordSession,
} from '../../test/fixtures/record-session.ts'
import { applyMigrations } from '../database/migrations.ts'
import { backfillLandingEvidenceRecords } from '../record/landing-outbox.ts'
import { startRecordApiServer } from '../record/record-api-server.ts'
import {
  bearerHeaders,
  noSpaceBuiltIns,
  RECORD_SESSION_KEY,
  recordAuth,
  setActiveRecordSpaceForSession,
} from '../record/record-auth.ts'
import {
  PROJECT_SETTING_COLUMNS,
  PROJECT_SETTINGS_NOT_IMPORTED,
} from '../record/record-project-columns.ts'
import { syncRecord } from '../record/record-sync.ts'
import { backfillReviewRecords } from '../review/review-outbox.ts'
import { backfillRunRecords } from '../run/run-outbox.ts'
import { HOOK_TREE_JOB, LANDING_TREE_JOB } from '../run/synthetic-lifecycle-job.ts'
import { backfillScoreRecords } from '../score/score-outbox.ts'
import { importProjects, projectImportRecordId } from './postgres-import.ts'
import { migratePostgres } from './postgres-migrate.ts'

const container = process.env.BOTTEGA_TEST_POSTGRES_CONTAINER
const databaseUrl = process.env.BOTTEGA_TEST_POSTGRES_URL
const migrateUrl = process.env.BOTTEGA_RECORD_MIGRATE_URL
const actorUrl = process.env.BOTTEGA_RECORD_URL
const sourceOrchDb = process.env.BOTTEGA_TEST_SOURCE_ORCH_DB
const sourceHubDb = process.env.BOTTEGA_TEST_SOURCE_HUB_DB
const realPostgres =
  container && databaseUrl && migrateUrl && actorUrl && sourceOrchDb && sourceHubDb
    ? describe
    : describe.skip

type SourceProject = {
  record_id: string | null
  name: string
  settings: string
  retired_at: string | null
}

test('project import keeps an existing record id and mints only when absent', () => {
  const existing = '01990000-0000-7000-8000-000000000001'
  const minted = '01990000-0000-7000-8000-000000000002'
  const mint = () => minted

  expect(projectImportRecordId(existing, mint)).toBe(existing)
  expect(projectImportRecordId(null, mint)).toBe(minted)
})

type ImportedProject = Record<string, unknown> & {
  name: string
  key_prefixes: string[]
}

function expectPreservedProjectIds(
  sourceProjects: SourceProject[],
  importedProjects: ImportedProject[],
): void {
  for (const source of sourceProjects) {
    if (source.record_id !== null) {
      expect(importedProjects.find((row) => row.name === source.name)?.id).toBe(source.record_id)
    }
  }
}

test('project-level autonomy is deliberately not imported', () => {
  const settings = { autonomy: { mode: 'supervised' } }
  const notImported = new Set<string>(PROJECT_SETTINGS_NOT_IMPORTED.map(({ key }) => key))
  const unknown = Object.keys(settings).filter((key) => !notImported.has(key))

  expect(unknown).toEqual([])
})

test('project import refuses without a signed-in user before opening its sources', async () => {
  // Production break watched: remove the principal guard from importProjects.
  await expect(
    importProjects({
      orchDb: 'missing',
      hubDb: 'missing',
      databaseUrl: 'missing',
      spaceId: 'space',
    }),
  ).rejects.toThrow(
    `a signed-in user is required; run \`${PLATFORM_SLUG} record sign-in\`, then retry`,
  )
})

async function targetState(sql: SQL): Promise<unknown> {
  const projects = await sql`
    SELECT id, space_id, name, key_prefixes, checkout_path, stack, canon, managed_context,
      visibility, landing_branch, production_branch, gate, worker_check, gate_input, focused_tests, agent_keys,
      require_clean_main, color, color_dark, env_prefix, mcp_server, worker_mcp_servers,
      secret_paths, mcp_probe_tool, mcp_reader_tools, mcp_writer_tools, docs, reference, signals, review,
      test_substance, mechanical_checks, release, states, tracker, worktree, retired_at, created_at
    FROM project ORDER BY name
  `
  const sequences = await sql`
    SELECT space_id, project_id, name, next::text AS next FROM seq ORDER BY project_id, name
  `
  return { projects: [...projects], sequences: [...sequences] }
}

realPostgres('project import against copied live SQLite data', () => {
  const sources = { orchDb: sourceOrchDb!, hubDb: sourceHubDb! }
  const unownedHubDb = `${sourceHubDb!}-unowned.db`
  const retiredOrchDb = `${sourceOrchDb!}-retired.db`
  const retiredHubDb = `${sourceHubDb!}-retired.db`
  const sql = new SQL(databaseUrl!)
  const recordSession = memoryRecordSession()
  let recordToken = ''
  let recordUserId = ''
  let apiServer: Awaited<ReturnType<typeof startRecordApiServer>>

  beforeAll(async () => {
    installRecordSessionRunner(recordSession.runner)
    process.env.BETTER_AUTH_SECRET = 'postgres-import-secret-at-least-thirty-two-characters'
    await migratePostgres()
    await sql`
      INSERT INTO invitation
        (id,space_id,email,inviter_id,role,status,expires_at,created_at)
      SELECT ${newRecordId()}::uuid, ${PLATFORM_SPACE_ID}::uuid, 'live-copy@example.test', id,
        'member', 'pending', now() + interval '1 day', now()
      FROM "user" ORDER BY created_at LIMIT 1
    `
    const signedUp = await recordAuth(
      actorUrl!,
      process.env,
      undefined,
      undefined,
      undefined,
      noSpaceBuiltIns,
    ).api.signUpEmail({
      body: {
        email: 'live-copy@example.test',
        name: 'Live Copy',
        password: 'correct-horse-battery-staple',
      },
    })
    if (!signedUp.token) throw new Error('live-copy signup returned no bearer token')
    recordToken = signedUp.token
    recordUserId = signedUp.user.id
    recordSession.setToken(recordToken)
    await sql`
      INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
      VALUES (${newRecordId()}::uuid, ${PLATFORM_SPACE_ID}::uuid, ${signedUp.user.id}::uuid, 'owner', 'write', now())
    `
    await setActiveRecordSpaceForSession(actorUrl!, bearerHeaders(recordToken), PLATFORM_SPACE_ID)
    apiServer = await startRecordApiServer({
      ...process.env,
      PORT: '0',
      BOTTEGA_RECORD_URL: actorUrl!,
      RECORD_AUTH_DATABASE_URL: process.env.RECORD_AUTH_DATABASE_URL ?? actorUrl!,
      BETTER_AUTH_URL: 'http://127.0.0.1',
      RECORD_HUB_URL: 'http://127.0.0.1',
    })
    process.env.BOTTEGA_RECORD_API_URL = `http://127.0.0.1:${apiServer.port}`
    installRecordApiClient(null)
  })

  beforeEach(() => installRecordApiClient(null))

  afterAll(async () => {
    await apiServer?.stop(true)
    installRecordSessionRunner(null)
    delete process.env.BOTTEGA_RECORD_API_URL
    delete process.env.BETTER_AUTH_SECRET
    await sql.unsafe(
      'DROP TABLE IF EXISTS run_exclusion, run_score, doc_revision, doc, membership, machine, seq, project, "user", space CASCADE',
    )
    await sql.unsafe('DROP SCHEMA IF EXISTS drizzle CASCADE')
    await sql.close()
    rmSync(unownedHubDb, { force: true })
    rmSync(retiredOrchDb, { force: true })
    rmSync(retiredHubDb, { force: true })
  })

  test('maps every source setting, reports the legacy skip, and is idempotent', async () => {
    expect(existsSync(sources.orchDb), sources.orchDb).toBe(true)
    expect(existsSync(sources.hubDb), sources.hubDb).toBe(true)
    const orch = new Database(sources.orchDb, { readonly: true })
    const hub = new Database(sources.hubDb, { readonly: true })
    const sourceProjects = orch
      .query<SourceProject, []>(
        'SELECT record_id, name, settings, retired_at FROM project ORDER BY name',
      )
      .all()
    const sourceSequences = hub
      .query<{ name: string; next: number }, []>('SELECT name, next FROM seq ORDER BY name')
      .all()
    orch.close()
    hub.close()

    const sourceKeySet = new Set(
      sourceProjects.flatMap((row) => Object.keys(JSON.parse(row.settings))),
    )

    const first = await importProjects({
      ...sources,
      databaseUrl: databaseUrl!,
      spaceId: PLATFORM_SPACE_ID,
      principal: { userId: recordUserId },
    })
    expect(first.projects).toBe(sourceProjects.length)
    expect(first.sequences).toBe(
      sourceSequences.filter((row) => row.name.startsWith('task:')).length,
    )
    expect(first.skippedSequences).toEqual(
      sourceSequences
        .filter((row) => !row.name.startsWith('task:'))
        .map((row) => ({
          name: row.name,
          next: row.next,
          reason: 'sequence name has no task: namespace and therefore no determinate project owner',
        })),
    )

    const sourceNames = new Set(sourceProjects.map(({ name }) => name))
    const imported = ((await sql`SELECT * FROM project ORDER BY name`) as ImportedProject[]).filter(
      ({ name }) => sourceNames.has(name),
    )
    expect(imported).toHaveLength(sourceProjects.length)
    expectPreservedProjectIds(sourceProjects, imported)
    const columnForSetting: Record<string, string> = Object.fromEntries([
      ...Object.entries(PROJECT_SETTING_COLUMNS).map(([setting, column]) => [
        setting,
        project[column].name,
      ]),
      ['mcp.reader_tools', project.mcpReaderTools.name],
      ['mcp.writer_tools', project.mcpWriterTools.name],
    ])
    const notImported = new Set<string>(PROJECT_SETTINGS_NOT_IMPORTED.map(({ key }) => key))
    expect(
      [...sourceKeySet].filter((key) => !(key in columnForSetting) && !notImported.has(key)),
    ).toEqual([])
    for (const source of sourceProjects) {
      const settings = JSON.parse(source.settings) as Record<string, unknown>
      const target = imported.find((row) => row.name === source.name)!
      expect(target.retired_at).toEqual(
        source.retired_at === null ? null : new Date(source.retired_at),
      )
      for (const key of Object.keys(settings)) {
        if (notImported.has(key)) continue
        expect(columnForSetting[key], `source setting ${key} has a target column`).toBeDefined()
        const expected =
          key === 'mcp' ? (settings.mcp as { probe_tool?: string }).probe_tool : settings[key]
        expect(target[columnForSetting[key]!] as unknown, `${source.name}.${key}`).toEqual(expected)
        if (key === 'mcp') {
          expect(target[columnForSetting['mcp.reader_tools']!] as unknown).toEqual(
            (settings.mcp as { reader_tools?: Record<string, string[]> }).reader_tools ?? null,
          )
          expect(target[columnForSetting['mcp.writer_tools']!] as unknown).toEqual(
            (settings.mcp as { writer_tools?: Record<string, string[]> }).writer_tools ?? null,
          )
        }
      }
    }

    const platform = imported.find((row) => row.name === PLATFORM_SLUG)!
    expect(platform).toBeDefined()
    const platformSettings = JSON.parse(
      sourceProjects.find((row) => row.name === PLATFORM_SLUG)!.settings,
    ) as Record<string, unknown>
    expect(platform.worker_mcp_servers).toEqual(platformSettings.workerMcpServers)
    expect(platform.worktree).toEqual(platformSettings.worktree)
    expect(platform.secret_paths).toBeNull()
    const adanim = imported.find((row) => row.name === 'adanim')!
    expect(adanim.key_prefixes).toEqual(['ADN', 'SHUL'])

    const importedSequences = await sql`
      SELECT seq.name, seq.next::text AS next, project.name AS project
      FROM seq JOIN project ON project.id = seq.project_id
      ORDER BY seq.name
    `
    const expectedSequences = sourceSequences
      .filter((row) => row.name.startsWith('task:'))
      .map((row) => {
        const prefix = row.name.slice('task:'.length)
        const owner = sourceProjects.find((project) =>
          (JSON.parse(project.settings).keyPrefixes as string[] | undefined)?.includes(prefix),
        )
        return { name: row.name, next: String(row.next), project: owner?.name }
      })
    expect([...importedSequences]).toEqual(expectedSequences)
    expect(
      expectedSequences.some((row) => row.name === 'task:DEV' && row.project === PLATFORM_SLUG),
    ).toBe(true)

    const before = await targetState(sql)
    const second = await importProjects({
      ...sources,
      databaseUrl: databaseUrl!,
      spaceId: PLATFORM_SPACE_ID,
      principal: { userId: recordUserId },
    })
    expect(second).toEqual(first)
    expect(await targetState(sql)).toEqual(before)
  })

  test('a retired project owns no imported sequence', async () => {
    copyFileSync(sources.orchDb, retiredOrchDb)
    copyFileSync(sources.hubDb, retiredHubDb)
    const orch = new Database(retiredOrchDb)
    const retired = orch
      .query<{ settings: string; retired_at: string | null }, []>(
        "SELECT settings, retired_at FROM project WHERE name='recipetrial'",
      )
      .get()!
    expect(retired.retired_at).not.toBeNull()
    const settings = JSON.parse(retired.settings) as Record<string, unknown>
    settings.keyPrefixes = ['RETIRED']
    orch
      .query("UPDATE project SET settings=? WHERE name='recipetrial'")
      .run(JSON.stringify(settings))
    orch.close()
    const hub = new Database(retiredHubDb)
    hub.query('INSERT INTO seq (name, next) VALUES (?, ?)').run('task:RETIRED', 7)
    hub.close()

    const result = await importProjects({
      orchDb: retiredOrchDb,
      hubDb: retiredHubDb,
      databaseUrl: databaseUrl!,
      spaceId: PLATFORM_SPACE_ID,
      principal: { userId: recordUserId },
    })
    expect(result.skippedSequences).toContainEqual({
      name: 'task:RETIRED',
      next: 7,
      reason: 'prefix is owned only by retired project: recipetrial',
    })
    const imported = await sql`SELECT count(*)::int AS count FROM seq WHERE name='task:RETIRED'`
    expect(imported[0]!.count).toBe(0)
  })

  test('backfills the copied live store and syncs every pending outbox row', async () => {
    const source = new Database(sources.orchDb)
    applyMigrations(source)
    source
      .query(
        `INSERT INTO schema_meta (key,value) VALUES (?,?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(RECORD_SESSION_KEY, recordToken)
    const sourceMachineId = source
      .query<{ value: string }, []>("SELECT value FROM schema_meta WHERE key='machine_id'")
      .get()!.value
    const historyIds = new Set(
      source
        .query<{ id: number }, []>('SELECT id FROM outbox WHERE synced_at IS NOT NULL')
        .all()
        .map((row) => row.id),
    )
    const backfill = backfillRunRecords(source, sourceMachineId)
    const scoreBackfill = backfillScoreRecords(source, sourceMachineId)
    const reviewBackfill = backfillReviewRecords(source)
    // The suite preload owns an isolated machine config, while this proof deliberately
    // replays a copied machine. Mint its new landing payloads as that copied machine.
    const configPath = join(process.env.BOTTEGA_CONFIG_HOME!, 'machine.toml')
    const testMachineConfig = readFileSync(configPath, 'utf8')
    const testMachineId = /\bid\s*=\s*"([^"]+)"/.exec(testMachineConfig)?.[1]
    if (!testMachineId) throw new Error(`test machine identity is absent from ${configPath}`)
    writeFileSync(configPath, testMachineConfig.replace(testMachineId, sourceMachineId))
    let landingEvidenceBackfill: ReturnType<typeof backfillLandingEvidenceRecords>
    try {
      landingEvidenceBackfill = backfillLandingEvidenceRecords(source)
    } finally {
      writeFileSync(configPath, testMachineConfig)
    }
    console.log(
      `live-copy backfill: enqueued ${backfill.enqueued}, refreshed-links ${backfill.refreshedLinks}, refreshed-numbers ${backfill.refreshedNumbers}, refreshed-roots ${backfill.refreshedRoots}, skipped-live ${backfill.skippedLive}`,
    )
    console.log(`live-copy score backfill: enqueued ${scoreBackfill}`)
    console.log(
      `live-copy review backfill: enqueued ${reviewBackfill.enqueuedReviews} reviews and ${reviewBackfill.enqueuedReads} reads`,
    )
    console.log(`live-copy landing evidence backfill: ${JSON.stringify(landingEvidenceBackfill)}`)
    const attemptsBeforeReplay = new Map(
      source
        .query<{ id: number; attempts: number }, []>('SELECT id, attempts FROM outbox')
        .all()
        .map((row) => [row.id, row.attempts]),
    )
    source
      .query("UPDATE outbox SET synced_at=NULL WHERE synced_at IS NOT NULL AND kind <> 'score'")
      .run()
    // The copy carries real started_by ids, whose users exist in the live record
    // and not in this fresh database, so the run foreign key would refuse them.
    // Stand-ins with those ids make the copy's attribution replayable here.
    for (const row of source
      .query<{ id: string }, []>(
        'SELECT DISTINCT started_by_user_id AS id FROM run WHERE started_by_user_id IS NOT NULL',
      )
      .all()) {
      await sql`
        INSERT INTO "user" (id,name,email,email_verified,created_at,updated_at)
        VALUES (${row.id}::uuid, 'Live copy stand-in', ${`stand-in-${row.id}@example.test`},
          false, now(), now())
        ON CONFLICT (id) DO NOTHING
      `
    }
    const projectSpaces = Object.fromEntries(
      source
        .query<{ name: string }, []>('SELECT name FROM project')
        .all()
        .map((project) => [project.name, PLATFORM_SPACE_ID]),
    )
    const refusedHistoryRows: Array<{
      id: number
      kind: string
      attempts: number
      last_error: string
    }> = []
    let replayPasses = 0
    while (true) {
      replayPasses++
      const synced = await syncRecord({
        local: source,
        identity: {
          id: sourceMachineId,
          name: 'live-copy-proof',
        },
        now: () => '2026-09-16T00:00:00.000Z',
        // The copy is replayed into this one harness space, so a project whose live
        // register names a space this user cannot reach maps here instead.
        projectSpaces,
      })
      console.log(
        `live-copy sync: pushed ${synced.pushed}, failed ${synced.failed}, pending ${synced.pending}`,
      )
      if (synced.pending === 0) break
      const refused = source
        .query<{ id: number; kind: string; attempts: number; last_error: string }, []>(
          `SELECT id, kind, attempts, last_error FROM outbox
           WHERE synced_at IS NULL AND last_error IS NOT NULL
           ORDER BY id`,
        )
        .all()
        .filter((row) => row.attempts > (attemptsBeforeReplay.get(row.id) ?? 0))
      const unexpected = refused.filter((row) => !historyIds.has(row.id))
      expect(unexpected).toEqual([])
      if (refused.length === 0 || unexpected.length > 0) break
      refusedHistoryRows.push(...refused)
      if (replayPasses >= 25) {
        throw new Error(
          `live-copy history replay exceeded 25 passes:\n${refusedHistoryRows
            .map((row) => `${row.id} ${row.kind}: ${row.last_error}`)
            .join('\n')}`,
        )
      }
      for (const row of refused) {
        source.query('UPDATE outbox SET synced_at=? WHERE id=?').run('history-refused', row.id)
      }
    }
    const outboxRows = source
      .query<
        {
          id: number
          synced_at: string | null
          last_error: string | null
          quarantined_at: string | null
          retired_at: string | null
        },
        []
      >('SELECT id, synced_at, last_error, quarantined_at, retired_at FROM outbox ORDER BY id')
      .all()
    const requiredRows = outboxRows.filter(
      (row) => !historyIds.has(row.id) && row.quarantined_at === null && row.retired_at === null,
    )
    expect(requiredRows.every((row) => row.synced_at !== null && row.last_error === null)).toBe(
      true,
    )
    expect(
      outboxRows
        .filter(
          (row) =>
            !historyIds.has(row.id) && (row.quarantined_at !== null || row.retired_at !== null),
        )
        .every((row) => row.synced_at === null),
    ).toBe(true)
    const refusedHistory = outboxRows.filter(
      (row) => historyIds.has(row.id) && row.last_error !== null,
    )
    const refusalMessages = [...new Set(refusedHistory.map((row) => row.last_error))]
    console.log(
      `live-copy history refused: ${refusedHistory.length}; errors: ${JSON.stringify(refusalMessages)}`,
    )
    const missingOutbox = source
      .query<{ count: number }, [string, string]>(
        `SELECT count(*) AS count FROM run r
         WHERE r.status <> 'running' AND r.job NOT IN (?,?)
           AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.kind='run' AND o.row_id=r.record_id)`,
      )
      .get(HOOK_TREE_JOB, LANDING_TREE_JOB)!.count
    expect(missingOutbox).toBe(0)
    source.close()
  })

  test('an unexpectedly unowned namespaced sequence aborts without partial writes', async () => {
    copyFileSync(sources.hubDb, unownedHubDb)
    const hub = new Database(unownedHubDb)
    hub.query('INSERT INTO seq (name, next) VALUES (?, ?)').run('task:NOPE', 5)
    hub.close()
    const before = await targetState(sql)

    await expect(
      importProjects({
        orchDb: sources.orchDb,
        hubDb: unownedHubDb,
        databaseUrl: databaseUrl!,
        spaceId: PLATFORM_SPACE_ID,
        principal: { userId: recordUserId },
      }),
    ).rejects.toThrow('cannot import sequence task:NOPE: matched no project')
    expect(await targetState(sql)).toEqual(before)
  })
})
