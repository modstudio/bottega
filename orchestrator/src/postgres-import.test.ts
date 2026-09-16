import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { copyFileSync, existsSync, rmSync } from 'node:fs'
import { SQL } from 'bun'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { backfillLandingEvidenceRecords } from './landing-outbox.ts'
import { applyMigrations } from './migrations.ts'
import { importProjects } from './postgres-import.ts'
import { migratePostgres } from './postgres-migrate.ts'
import { newRecordId, PLATFORM_SPACE_ID } from './postgres-schema.ts'
import { RECORD_SESSION_KEY, recordAuth, setActiveRecordSpace } from './record-auth.ts'
import { syncRecord } from './record-sync.ts'
import { backfillReviewRecords } from './review-outbox.ts'
import { backfillRunRecords } from './run-outbox.ts'

const container = process.env.ORCH_TEST_POSTGRES_CONTAINER
const databaseUrl = process.env.ORCH_TEST_POSTGRES_URL
const migrateUrl = process.env.ORCH_RECORD_MIGRATE_URL
const actorUrl = process.env.ORCH_RECORD_URL
const sourceOrchDb = process.env.ORCH_TEST_SOURCE_ORCH_DB
const sourceHubDb = process.env.ORCH_TEST_SOURCE_HUB_DB
const realPostgres =
  container && databaseUrl && migrateUrl && actorUrl && sourceOrchDb && sourceHubDb
    ? describe
    : describe.skip

type SourceProject = {
  name: string
  settings: string
  retired_at: string | null
}

type ImportedProject = Record<string, unknown> & {
  name: string
  key_prefixes: string[]
}

async function targetState(sql: SQL): Promise<unknown> {
  const projects = await sql`
    SELECT id, space_id, name, key_prefixes, checkout_path, stack, canon,
      landing_branch, production_branch, gate, require_clean_main, color,
      color_dark, env_prefix, mcp_server, worker_mcp_servers, secret_paths,
      mcp_probe_tool, tracker, worktree, retired_at, created_at
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
  let recordToken = ''

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET = 'postgres-import-secret-at-least-thirty-two-characters'
    await migratePostgres()
    const signedUp = await recordAuth(actorUrl!).api.signUpEmail({
      body: {
        email: 'live-copy@example.test',
        name: 'Live Copy',
        password: 'correct-horse-battery-staple',
      },
    })
    if (!signedUp.token) throw new Error('live-copy signup returned no bearer token')
    recordToken = signedUp.token
    await sql`
      INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
      VALUES (${newRecordId()}::uuid, ${PLATFORM_SPACE_ID}::uuid, ${signedUp.user.id}::uuid, 'owner', 'write', now())
    `
    await setActiveRecordSpace(actorUrl!, recordToken, PLATFORM_SPACE_ID)
  })

  afterAll(async () => {
    delete process.env.BETTER_AUTH_SECRET
    await sql.unsafe(
      'DROP TABLE IF EXISTS membership, machine, seq, project, "user", space CASCADE',
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
      .query<SourceProject, []>('SELECT name, settings, retired_at FROM project ORDER BY name')
      .all()
    const sourceSequences = hub
      .query<{ name: string; next: number }, []>('SELECT name, next FROM seq ORDER BY name')
      .all()
    orch.close()
    hub.close()

    const sourceKeySet = new Set(
      sourceProjects.flatMap((row) => Object.keys(JSON.parse(row.settings))),
    )
    expect([...sourceKeySet].sort()).toEqual([
      'color',
      'colorDark',
      'envPrefix',
      'gate',
      'keyPrefixes',
      'mcp',
      'mcpServer',
      'tracker',
      'trunk',
      'workerMcpServers',
      'worktree',
    ])

    const first = await importProjects({
      ...sources,
      databaseUrl: databaseUrl!,
      spaceId: PLATFORM_SPACE_ID,
    })
    expect(first.projects).toBe(sourceProjects.length)
    expect(first.sequences).toBe(
      sourceSequences.filter((row) => row.name.startsWith('task:')).length,
    )
    expect(first.skippedSequences).toEqual([
      {
        name: 'dev',
        next: 21,
        reason: 'sequence name has no task: namespace and therefore no determinate project owner',
      },
    ])

    const imported = (await sql`SELECT * FROM project ORDER BY name`) as ImportedProject[]
    expect(imported).toHaveLength(sourceProjects.length)
    const columnForSetting: Record<string, string> = {
      color: 'color',
      colorDark: 'color_dark',
      envPrefix: 'env_prefix',
      gate: 'gate',
      keyPrefixes: 'key_prefixes',
      mcp: 'mcp_probe_tool',
      mcpServer: 'mcp_server',
      secretPaths: 'secret_paths',
      tracker: 'tracker',
      trunk: 'landing_branch',
      worktree: 'worktree',
      workerMcpServers: 'worker_mcp_servers',
    }
    for (const source of sourceProjects) {
      const settings = JSON.parse(source.settings) as Record<string, unknown>
      const target = imported.find((row) => row.name === source.name)!
      expect(target.retired_at).toEqual(
        source.retired_at === null ? null : new Date(source.retired_at),
      )
      for (const key of Object.keys(settings)) {
        expect(columnForSetting[key], `source setting ${key} has a target column`).toBeDefined()
        const expected =
          key === 'mcp' ? (settings.mcp as { probe_tool: string }).probe_tool : settings[key]
        expect(target[columnForSetting[key]!] as unknown, `${source.name}.${key}`).toEqual(expected)
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
    })
    expect(result.skippedSequences).toContainEqual({
      name: 'task:RETIRED',
      next: 7,
      reason: 'prefix is owned only by retired project: recipetrial',
    })
    const imported = await sql`SELECT count(*)::int AS count FROM seq WHERE name='task:RETIRED'`
    expect(imported[0]!.count).toBe(0)
  })

  test('backfills the copied live store and syncs every finished turn through the outbox', async () => {
    const source = new Database(sources.orchDb)
    applyMigrations(source)
    source
      .query(
        `INSERT INTO schema_meta (key,value) VALUES (?,?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(RECORD_SESSION_KEY, recordToken)
    const noProject = source
      .query<{ count: number }, []>(
        "SELECT count(*) AS count FROM run WHERE project_id IS NULL AND status <> 'running'",
      )
      .get()!.count
    const sourceMachineId = source
      .query<{ value: string }, []>("SELECT value FROM schema_meta WHERE key='machine_id'")
      .get()!.value
    source.query('UPDATE outbox SET synced_at=NULL').run()
    const backfill = backfillRunRecords(source, sourceMachineId)
    const reviewBackfill = backfillReviewRecords(source)
    const landingEvidenceBackfill = backfillLandingEvidenceRecords(source)
    console.log(
      `live-copy backfill: minted ${backfill.minted}, enqueued ${backfill.enqueued}, skipped-live ${backfill.skippedLive}`,
    )
    console.log(
      `live-copy review backfill: minted ${reviewBackfill.mintedReviews} reviews, ${reviewBackfill.mintedLenses} lenses, ${reviewBackfill.mintedFindings} findings; enqueued ${reviewBackfill.enqueuedReviews} reviews`,
    )
    console.log(`live-copy landing evidence backfill: ${JSON.stringify(landingEvidenceBackfill)}`)
    const sourceEvidenceCounts = source
      .query<
        {
          landings: number
          overrides: number
          carries: number
          contentions: number
          flakes: number
        },
        []
      >(
        `SELECT (SELECT count(*) FROM landing) AS landings,
                (SELECT count(*) FROM landing_override) AS overrides,
                (SELECT count(*) FROM landing_review_carry) AS carries,
                (SELECT count(*) FROM contention) AS contentions,
                (SELECT count(*) FROM test_flake) AS flakes`,
      )
      .get()!
    const sourceReviewCounts = source
      .query<{ reviews: number; lenses: number; findings: number }, []>(
        `SELECT (SELECT count(*) FROM review) AS reviews,
              (SELECT count(*) FROM review_lens) AS lenses,
              (SELECT count(*) FROM review_finding) AS findings`,
      )
      .get()!
    const sourceNullPatchIdentity = source
      .query<{ count: number }, []>(
        'SELECT count(*) AS count FROM review WHERE patch_id IS NULL AND path_set IS NULL',
      )
      .get()!.count
    const expectedRecordRuns = source
      .query<{ count: number }, []>(
        `SELECT count(DISTINCT r.id) AS count
         FROM run r JOIN outbox o ON o.record_id=r.record_id AND o.kind='run'`,
      )
      .get()!.count
    const synced = await syncRecord({
      recordUrl: actorUrl!,
      local: source,
      identity: {
        id: sourceMachineId,
        name: 'live-copy-proof',
      },
      now: () => '2026-09-16T00:00:00.000Z',
    })
    console.log(
      `live-copy sync: pushed ${synced.pushed}, failed ${synced.failed}, pending ${synced.pending}`,
    )
    expect(synced.failed).toBe(0)
    expect(synced.pending).toBe(0)
    const recordCount = await sql`SELECT count(*)::int AS count FROM run`
    expect(recordCount[0]!.count).toBe(expectedRecordRuns)
    const recordReviewCounts = await sql`
      SELECT (SELECT count(*)::int FROM review) AS reviews,
             (SELECT count(*)::int FROM review_lens) AS lenses,
             (SELECT count(*)::int FROM review_finding) AS findings
    `
    expect(recordReviewCounts[0]).toMatchObject(sourceReviewCounts)
    const recordEvidenceCounts = await sql`
      SELECT (SELECT count(*)::int FROM landing) AS landings,
             (SELECT count(*)::int FROM landing_override) AS overrides,
             (SELECT count(*)::int FROM landing_review_carry) AS carries,
             (SELECT count(*)::int FROM contention) AS contentions,
             (SELECT count(*)::int FROM test_flake) AS flakes
    `
    expect(recordEvidenceCounts[0]).toMatchObject(sourceEvidenceCounts)
    const missingLensReferences = await sql`
      SELECT count(*)::int AS count FROM review_lens lens
      LEFT JOIN review ON review.id=lens.review_id
      LEFT JOIN run ON run.id=lens.run_id
      WHERE review.id IS NULL OR run.id IS NULL
    `
    expect(missingLensReferences[0]!.count).toBe(0)
    const missingFindingReferences = await sql`
      SELECT count(*)::int AS count FROM review_finding finding
      LEFT JOIN review ON review.id=finding.review_id
      LEFT JOIN review_lens lens ON lens.id=finding.review_lens_id
      WHERE review.id IS NULL OR lens.id IS NULL
    `
    expect(missingFindingReferences[0]!.count).toBe(0)
    const missingCarryReferences = await sql`
      SELECT count(*)::int AS count FROM landing_review_carry carry
      LEFT JOIN review ON review.id=carry.review_id
      WHERE review.id IS NULL
    `
    expect(missingCarryReferences[0]!.count).toBe(0)
    const missingContentionReferences = await sql`
      SELECT count(*)::int AS count FROM contention evidence
      LEFT JOIN run ON run.id=evidence.run_id
      LEFT JOIN landing ON landing.id=evidence.landing_id
      WHERE (evidence.run_id IS NOT NULL AND run.id IS NULL)
         OR (evidence.landing_id IS NOT NULL AND landing.id IS NULL)
    `
    expect(missingContentionReferences[0]!.count).toBe(0)
    const flakeProjects = await sql`
      SELECT count(*)::int AS count FROM test_flake WHERE project_id IS NOT NULL
    `
    expect(flakeProjects[0]!.count).toBe(0)
    const recordNullPatchIdentity = await sql`
      SELECT count(*)::int AS count FROM review WHERE patch_id IS NULL AND path_set IS NULL
    `
    expect(sourceNullPatchIdentity).toBe(369)
    expect(recordNullPatchIdentity[0]!.count).toBe(sourceNullPatchIdentity)
    const missingOutbox = source
      .query<{ count: number }, []>(
        `SELECT count(*) AS count FROM run r
         WHERE r.status <> 'running'
           AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.kind='run' AND o.record_id=r.record_id)`,
      )
      .get()!.count
    expect(missingOutbox).toBe(0)
    const missingChains = await sql`
      SELECT count(*)::int AS count
      FROM run child
      LEFT JOIN run retry ON retry.id=child.retry_of
      LEFT JOIN run parent ON parent.id=child.parent_run_id
      WHERE (child.retry_of IS NOT NULL AND retry.id IS NULL)
         OR (child.parent_run_id IS NOT NULL AND parent.id IS NULL)
    `
    expect(missingChains[0]!.count).toBe(0)
    const recordNoProject =
      await sql`SELECT count(*)::int AS count FROM run WHERE project_id IS NULL`
    expect(noProject).toBe(97)
    expect(recordNoProject[0]!.count).toBe(noProject)
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
      }),
    ).rejects.toThrow('cannot import sequence task:NOPE: matched no project')
    expect(await targetState(sql)).toEqual(before)
  })
})
