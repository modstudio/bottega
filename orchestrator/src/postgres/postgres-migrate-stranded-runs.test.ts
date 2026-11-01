import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SQL } from 'bun'
import { drizzle } from 'drizzle-orm/bun-sql'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { PLATFORM_SPACE_ID } from '../../../shared/record/schema.ts'

const successUrl = process.env.BOTTEGA_TEST_STRANDED_RUNS_URL
const mismatchUrl = process.env.BOTTEGA_TEST_STRANDED_RUNS_MISMATCH_URL
const referenceUrl = process.env.BOTTEGA_TEST_STRANDED_RUNS_REFERENCE_URL
const emptyUrl = process.env.BOTTEGA_TEST_STRANDED_RUNS_EMPTY_URL
const selfReferenceUrl = process.env.BOTTEGA_TEST_STRANDED_RUNS_SELF_REFERENCE_URL
const realPostgres =
  successUrl && mismatchUrl && referenceUrl && emptyUrl && selfReferenceUrl
    ? describe
    : describe.skip
const migrationsFolder = join(import.meta.dir, '..', '..', '..', 'shared', 'record', 'migrations')
const migrationName = '20261101151500_dev_1994_stranded_runs'
const migrationSql = readFileSync(join(migrationsFolder, migrationName, 'migration.sql'), 'utf8')
const listedRuns = [...migrationSql.matchAll(/\('([0-9a-f-]{36})','([0-9a-f-]{36})'\)/g)].map(
  (match) => ({ runId: match[1]!, projectId: match[2]! }),
)
let priorMigrations = ''

const userId = '01990000-0000-7000-8000-000000001991'
const machineId = '01990000-0000-7000-8000-000000001992'
const unrelatedRun = '01990000-0000-7000-8000-000000001993'
const unlistedRun = '01990000-0000-7000-8000-000000001994'
const questionId = '01990000-0000-7000-8000-000000001995'
const unrelatedProject = '01990000-0000-7000-8000-000000001996'
const unrelatedSpace = '01990000-0000-7000-8000-000000001997'
const projectSpaces = new Map([
  ['01a0ab08-26bf-7000-b8bd-d50ee3bdae3b', '01990000-0000-7000-8000-000000001981'],
  ['01a0ab08-26d0-7000-86c3-b81996f2fb1d', '01990000-0000-7000-8000-000000001982'],
  ['01a0ab08-26df-7000-a916-594f80673fb4', '01990000-0000-7000-8000-000000001983'],
])

const sqlValues = (values: string[]) => values.map((value) => `'${value}'`).join(',')
const runRows = (runs: typeof listedRuns) =>
  runs
    .map(
      ({ runId }) =>
        `('${runId}','${PLATFORM_SPACE_ID}','${machineId}','${userId}',now(),'codex','write','sha',1,'prompt',false,'ok',0,false,false,false,now(),now())`,
    )
    .join(',')

async function seed(
  sql: SQL,
  runs: typeof listedRuns,
  options?: { unlisted?: boolean; question?: boolean },
) {
  const projects = [...projectSpaces].map(
    ([projectId, spaceId], index) => `('${projectId}','${spaceId}','target-${index}',now())`,
  )
  await sql.unsafe(`
    ALTER TABLE space NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE project NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE run NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE run_score NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE run_exclusion NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE contention NO FORCE ROW LEVEL SECURITY;
    ${options?.question ? 'ALTER TABLE question NO FORCE ROW LEVEL SECURITY;' : ''}
    INSERT INTO space(id,name,slug,created_at) VALUES
      ${[...projectSpaces.values()].map((id, index) => `('${id}','Target ${index}','target-${index}',now())`).join(',')};
    INSERT INTO "user"(id,email,name,created_at) VALUES('${userId}','dev-1994@example.test','DEV-1994',now());
    INSERT INTO machine(id,user_id,name,registered_at,last_seen) VALUES('${machineId}','${userId}','dev-1994',now(),now());
    INSERT INTO project(id,space_id,name,created_at) VALUES ${projects.join(',')};
    INSERT INTO run(id,space_id,machine_id,started_by_user_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,probe,status,turn,no_failover,automatic_failover,work_preserved,created_at,updated_at)
      VALUES ${runRows(runs)},
      ('${unrelatedRun}','${PLATFORM_SPACE_ID}','${machineId}','${userId}',now(),'codex','write','sha',1,'prompt',true,'ok',0,false,false,false,now(),now())
      ${options?.unlisted ? `,('${unlistedRun}','${PLATFORM_SPACE_ID}','${machineId}','${userId}',now(),'codex','write','sha',1,'prompt',false,'ok',0,false,false,false,now(),now())` : ''};
    UPDATE run SET parent_run_id='${runs[0]?.runId ?? unrelatedRun}' WHERE id='${runs[1]?.runId ?? unrelatedRun}';
    INSERT INTO run_score(run_id,space_id,delivery,scored_at,scored_by,updated_at)
      SELECT id,space_id,'none',now(),'proof',now() FROM run WHERE id IN (${sqlValues(runs.map((run) => run.runId))});
    INSERT INTO run_exclusion(run_id,space_id,reason,excluded_at)
      SELECT id,space_id,'proof',now() FROM run WHERE id IN (${sqlValues(runs.map((run) => run.runId))});
    INSERT INTO contention(id,space_id,machine_id,at,resource_kind,resource_key,event_kind,run_id,created_at,updated_at)
      SELECT gen_random_uuid(),space_id,'${machineId}',now(),'proof',id::text,'wait',id,now(),now() FROM run WHERE id IN (${sqlValues(runs.map((run) => run.runId))});
    ${
      options?.question
        ? `INSERT INTO question(id,space_id,run_id,machine_id,revision,asked_at,question,withheld_fields,created_at,updated_at)
             VALUES('${questionId}','${PLATFORM_SPACE_ID}','${runs[0]!.runId}','${machineId}',1,now(),'proof','{}',now(),now());`
        : ''
    }
    ALTER TABLE contention FORCE ROW LEVEL SECURITY;
    ALTER TABLE run_exclusion FORCE ROW LEVEL SECURITY;
    ALTER TABLE run_score FORCE ROW LEVEL SECURITY;
    ALTER TABLE run FORCE ROW LEVEL SECURITY;
    ALTER TABLE project FORCE ROW LEVEL SECURITY;
    ALTER TABLE space FORCE ROW LEVEL SECURITY;
    ${options?.question ? 'ALTER TABLE question FORCE ROW LEVEL SECURITY;' : ''}
  `)
}

async function seedUnrelatedRecord(sql: SQL) {
  await sql.unsafe(`
    ALTER TABLE space NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE project NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE run NO FORCE ROW LEVEL SECURITY;
    INSERT INTO space(id,name,slug,created_at)
      VALUES('${unrelatedSpace}','Unrelated','unrelated',now());
    INSERT INTO "user"(id,email,name,created_at)
      VALUES('${userId}','dev-1994-unrelated@example.test','DEV-1994 unrelated',now());
    INSERT INTO machine(id,user_id,name,registered_at,last_seen)
      VALUES('${machineId}','${userId}','dev-1994-unrelated',now(),now());
    INSERT INTO project(id,space_id,name,created_at)
      VALUES('${unrelatedProject}','${unrelatedSpace}','unrelated',now());
    INSERT INTO run(id,space_id,project_id,machine_id,started_by_user_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,probe,status,turn,no_failover,automatic_failover,work_preserved,created_at,updated_at)
      VALUES('${unrelatedRun}','${unrelatedSpace}','${unrelatedProject}','${machineId}','${userId}',now(),'codex','write','sha',1,'prompt',false,'ok',0,false,false,false,now(),now());
    ALTER TABLE run FORCE ROW LEVEL SECURITY;
    ALTER TABLE project FORCE ROW LEVEL SECURITY;
    ALTER TABLE space FORCE ROW LEVEL SECURITY;
  `)
}

async function runFacts(sql: SQL, query: string) {
  await sql.unsafe('ALTER TABLE run NO FORCE ROW LEVEL SECURITY')
  try {
    return await sql.unsafe(query)
  } finally {
    await sql.unsafe('ALTER TABLE run FORCE ROW LEVEL SECURITY')
  }
}

async function movedFacts(sql: SQL) {
  await sql.unsafe(`
    ALTER TABLE run NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE run_score NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE run_exclusion NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE contention NO FORCE ROW LEVEL SECURITY;
  `)
  const facts = await sql.unsafe(`
    SELECT r.id::text run_id,r.space_id::text,r.project_id::text,
      s.space_id=r.space_id score_moved,e.space_id=r.space_id exclusion_moved,
      c.space_id=r.space_id contention_moved
    FROM run r
    JOIN run_score s ON s.run_id=r.id
    JOIN run_exclusion e ON e.run_id=r.id
    JOIN contention c ON c.run_id=r.id
    WHERE r.id IN (${sqlValues(listedRuns.map((run) => run.runId))}) ORDER BY r.id
  `)
  await sql.unsafe(`
    ALTER TABLE contention FORCE ROW LEVEL SECURITY;
    ALTER TABLE run_exclusion FORCE ROW LEVEL SECURITY;
    ALTER TABLE run_score FORCE ROW LEVEL SECURITY;
    ALTER TABLE run FORCE ROW LEVEL SECURITY;
  `)
  return facts
}

realPostgres('DEV-1994 stranded hosted runs', () => {
  beforeAll(() => {
    expect(listedRuns).toHaveLength(47)
    priorMigrations = mkdtempSync(join(tmpdir(), 'dev-1994-stranded-runs-'))
    for (const folder of readdirSync(migrationsFolder).filter((name) => name < migrationName))
      cpSync(join(migrationsFolder, folder), join(priorMigrations, folder), { recursive: true })
  })

  afterAll(() => rmSync(priorMigrations, { recursive: true, force: true }))

  test('moves every listed run and declared run-owned row and reruns as a no-op', async () => {
    const sql = new SQL(successUrl!)
    try {
      await migrate(drizzle({ client: sql }), { migrationsFolder: priorMigrations })
      await seed(sql, listedRuns)
      await migrate(drizzle({ client: sql }), { migrationsFolder })
      const facts = await movedFacts(sql)
      expect(facts).toHaveLength(47)
      for (const fact of facts) {
        const listed = listedRuns.find((run) => run.runId === fact.run_id)!
        expect(fact).toEqual({
          run_id: listed.runId,
          space_id: projectSpaces.get(listed.projectId),
          project_id: listed.projectId,
          score_moved: true,
          exclusion_moved: true,
          contention_moved: true,
        })
      }
      await sql.unsafe(migrationSql)
      const unrelated = await runFacts(
        sql,
        `SELECT space_id::text,project_id::text FROM run WHERE id='${unrelatedRun}'`,
      )
      expect(unrelated).toEqual([{ space_id: PLATFORM_SPACE_ID, project_id: null }])
    } finally {
      await sql.close()
    }
  })

  test('a measured-set mismatch reports counts and rolls back', async () => {
    const sql = new SQL(mismatchUrl!)
    try {
      await migrate(drizzle({ client: sql }), { migrationsFolder: priorMigrations })
      await seed(sql, listedRuns.slice(1), { unlisted: true })
      await expect(sql.unsafe(migrationSql)).rejects.toThrow(
        'found 47, expected 47, listed missing 1, unlisted present 1',
      )
      const remaining = await runFacts(
        sql,
        `SELECT count(*)::int count FROM run WHERE project_id IS NULL AND NOT probe`,
      )
      expect(remaining).toEqual([{ count: 47 }])
    } finally {
      await sql.close()
    }
  })

  test('a non-owned run foreign-key reference names its table and rolls back', async () => {
    const sql = new SQL(referenceUrl!)
    try {
      await migrate(drizzle({ client: sql }), { migrationsFolder: priorMigrations })
      await seed(sql, listedRuns, { question: true })
      await expect(sql.unsafe(migrationSql)).rejects.toThrow('question=1')
      const remaining = await runFacts(
        sql,
        `SELECT count(*)::int count FROM run WHERE project_id IS NULL AND NOT probe`,
      )
      expect(remaining).toEqual([{ count: 47 }])
    } finally {
      await sql.close()
    }
  })

  test('a record with none of the listed runs is unchanged', async () => {
    const sql = new SQL(emptyUrl!)
    try {
      await migrate(drizzle({ client: sql }), { migrationsFolder: priorMigrations })
      await seedUnrelatedRecord(sql)
      expect(migrationSql).toContain(
        "NOTICE 'DEV-1994: hosted record holds none of the listed runs; no rows changed'",
      )
      await sql.unsafe(migrationSql)
      expect(
        await runFacts(
          sql,
          `SELECT space_id::text,project_id::text FROM run WHERE id='${unrelatedRun}'`,
        ),
      ).toEqual([{ space_id: unrelatedSpace, project_id: unrelatedProject }])
    } finally {
      await sql.close()
    }
  })

  test('an unlisted run self-reference names run and rolls back', async () => {
    const sql = new SQL(selfReferenceUrl!)
    try {
      await migrate(drizzle({ client: sql }), { migrationsFolder: priorMigrations })
      await seed(sql, listedRuns)
      await sql.unsafe('ALTER TABLE run NO FORCE ROW LEVEL SECURITY')
      await sql.unsafe(
        `UPDATE run SET parent_run_id='${listedRuns[0]!.runId}' WHERE id='${unrelatedRun}'`,
      )
      await sql.unsafe('ALTER TABLE run FORCE ROW LEVEL SECURITY')
      await expect(sql.unsafe(migrationSql)).rejects.toThrow('run=1')
      const remaining = await runFacts(
        sql,
        `SELECT count(*)::int count FROM run WHERE project_id IS NULL AND NOT probe`,
      )
      expect(remaining).toEqual([{ count: 47 }])
    } finally {
      await sql.close()
    }
  })
})
