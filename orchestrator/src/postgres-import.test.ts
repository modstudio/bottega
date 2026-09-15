import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { SQL } from 'bun'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { importProjects } from './postgres-import.ts'
import { PLATFORM_SPACE_ID } from './postgres-schema.ts'

const container = process.env.ORCH_TEST_POSTGRES_CONTAINER
const databaseUrl = process.env.ORCH_TEST_POSTGRES_URL
const sourceOrchDb = process.env.ORCH_TEST_SOURCE_ORCH_DB
const sourceHubDb = process.env.ORCH_TEST_SOURCE_HUB_DB
const realPostgres =
  container && databaseUrl && sourceOrchDb && sourceHubDb ? describe : describe.skip

type SourceProject = {
  name: string
  settings: string
}

type ImportedProject = Record<string, unknown> & {
  name: string
  key_prefixes: string[]
}

const migrations = ['0000_substrate.sql', '0001_project_import_shape.sql'].map((file) =>
  readFileSync(join(import.meta.dir, '..', 'postgres', 'migrations', file), 'utf8'),
)

async function targetState(sql: SQL): Promise<unknown> {
  const projects = await sql`
    SELECT id, space_id, name, key_prefixes, checkout_path, stack, canon,
      landing_branch, production_branch, gate, require_clean_main, color,
      color_dark, env_prefix, mcp_server, mcp_probe_tool, tracker,
      worktree_recipe, created_at
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
  const sql = new SQL(databaseUrl!)

  beforeAll(async () => {
    for (const migration of migrations) await sql.unsafe(migration)
  })

  afterAll(async () => {
    await sql.unsafe(
      'DROP TABLE IF EXISTS membership, machine, seq, project, "user", space CASCADE',
    )
    await sql.close()
    rmSync(unownedHubDb, { force: true })
  })

  test('maps every source setting, reports the legacy skip, and is idempotent', async () => {
    expect(existsSync(sources.orchDb), sources.orchDb).toBe(true)
    expect(existsSync(sources.hubDb), sources.hubDb).toBe(true)
    const orch = new Database(sources.orchDb, { readonly: true })
    const hub = new Database(sources.hubDb, { readonly: true })
    const sourceProjects = orch
      .query<SourceProject, []>('SELECT name, settings FROM project ORDER BY name')
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
      tracker: 'tracker',
      trunk: 'landing_branch',
      worktree: 'worktree_recipe',
    }
    for (const source of sourceProjects) {
      const settings = JSON.parse(source.settings) as Record<string, unknown>
      const target = imported.find((row) => row.name === source.name)!
      for (const key of Object.keys(settings)) {
        expect(columnForSetting[key], `source setting ${key} has a target column`).toBeDefined()
        const expected =
          key === 'mcp' ? (settings.mcp as { probe_tool: string }).probe_tool : settings[key]
        expect(target[columnForSetting[key]!] as unknown, `${source.name}.${key}`).toEqual(expected)
      }
    }

    const platform = imported.find((row) => row.name === PLATFORM_SLUG)!
    expect(platform).toBeDefined()
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
