import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SQL } from 'bun'
import { drizzle } from 'drizzle-orm/bun-sql'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { migrationSessionStatements } from '../../../shared/record/migration-session.ts'

const url = process.env.BOTTEGA_TEST_ROUTING_EVIDENCE_MIGRATION_URL
const postgres = url ? describe : describe.skip
const migrationsFolder = join(import.meta.dir, '..', '..', '..', 'shared', 'record', 'migrations')
const backfillMigration = '20261101215249_dev_2022_routing_evidence_sequence_backfill'
let priorMigrations = ''

const USER_ID = '01990000-0000-7000-8000-000000020220'
const MACHINE_ID = '01990000-0000-7000-8000-000000020221'
const FIRST_SPACE_ID = '01990000-0000-7000-8000-000000020222'
const SECOND_SPACE_ID = '01990000-0000-7000-8000-000000020223'
const FIRST_SPACE_RUNS = [
  '01990000-0000-7000-8000-000000020224',
  '01990000-0000-7000-8000-000000020225',
  '01990000-0000-7000-8000-000000020226',
] as const
const SECOND_SPACE_RUNS = [
  '01990000-0000-7000-8000-000000020227',
  '01990000-0000-7000-8000-000000020228',
] as const

type SequenceRow = { id: string; evidence_seq: string | bigint }

postgres('populated routing evidence sequence backfill migration', () => {
  beforeAll(async () => {
    priorMigrations = mkdtempSync(join(tmpdir(), 'dev-2022-prior-migrations-'))
    for (const folder of readdirSync(migrationsFolder).filter((name) => name < backfillMigration))
      cpSync(join(migrationsFolder, folder), join(priorMigrations, folder), { recursive: true })

    const sql = new SQL({ url: url!, max: 1 })
    try {
      for (const statement of migrationSessionStatements()) await sql.unsafe(statement)
      await migrate(drizzle({ client: sql }), { migrationsFolder: priorMigrations })
      await sql.unsafe(`
        ALTER TABLE run NO FORCE ROW LEVEL SECURITY;
        ALTER TABLE run_score NO FORCE ROW LEVEL SECURITY;
        ALTER TABLE review_lens NO FORCE ROW LEVEL SECURITY;
      `)
      await sql`INSERT INTO space (id,name,slug,created_at) VALUES
        (${FIRST_SPACE_ID}::uuid,'First evidence backfill','first-evidence-backfill','2026-01-01T00:00:00Z'::timestamptz),
        (${SECOND_SPACE_ID}::uuid,'Second evidence backfill','second-evidence-backfill','2026-01-01T00:00:00Z'::timestamptz)`
      await sql`INSERT INTO "user" (id,email,name,created_at) VALUES
        (${USER_ID}::uuid,'evidence-backfill@example.test','Evidence Backfill','2026-01-01T00:00:00Z'::timestamptz)`
      await sql`INSERT INTO machine (id,user_id,name,registered_at,last_seen) VALUES
        (${MACHINE_ID}::uuid,${USER_ID}::uuid,'evidence-backfill','2026-01-01T00:00:00Z'::timestamptz,'2026-01-01T00:00:00Z'::timestamptz)`

      const runs = [
        [FIRST_SPACE_RUNS[0], FIRST_SPACE_ID, '2026-01-01T00:00:00Z'],
        [FIRST_SPACE_RUNS[1], FIRST_SPACE_ID, '2026-01-02T00:00:00Z'],
        [FIRST_SPACE_RUNS[2], FIRST_SPACE_ID, '2026-01-03T00:00:00Z'],
        [SECOND_SPACE_RUNS[0], SECOND_SPACE_ID, '2026-01-06T00:00:00Z'],
        [SECOND_SPACE_RUNS[1], SECOND_SPACE_ID, '2026-01-07T00:00:00Z'],
      ] as const
      for (const [id, spaceId, updatedAt] of runs)
        await sql`INSERT INTO run (
          id,space_id,machine_id,started_by_user_id,started_at,agent,job,prompt_sha,prompt_bytes,
          prompt_head,probe,status,turn,no_failover,automatic_failover,work_preserved,created_at,updated_at
        ) VALUES (
          ${id}::uuid,${spaceId}::uuid,${MACHINE_ID}::uuid,${USER_ID}::uuid,${updatedAt}::timestamptz,
          'agent','implement','sha',1,'head',false,'ok',1,false,false,false,
          ${updatedAt}::timestamptz,${updatedAt}::timestamptz
        )`

      await sql`INSERT INTO run_score (
        run_id,space_id,delivery,quality,fidelity,scored_at,scored_by,updated_at
      ) VALUES
        (${FIRST_SPACE_RUNS[0]}::uuid,${FIRST_SPACE_ID}::uuid,'full','right','faithful','2026-01-04T00:00:00Z'::timestamptz,'architect','2026-01-04T00:00:00Z'::timestamptz),
        (${SECOND_SPACE_RUNS[1]}::uuid,${SECOND_SPACE_ID}::uuid,'full','right','faithful','2026-01-08T00:00:00Z'::timestamptz,'architect','2026-01-08T00:00:00Z'::timestamptz)`
      await sql`INSERT INTO review_lens (
        id,space_id,review_id,run_id,machine_id,lens,agent,standards_read,files_covered,
        commands_run,could_not_verify,mcp_tools,docs_read,substitutes,created_at,updated_at
      ) VALUES
        ('01990000-0000-7000-8000-000000020229'::uuid,${FIRST_SPACE_ID}::uuid,'01990000-0000-7000-8000-000000020230'::uuid,${FIRST_SPACE_RUNS[1]}::uuid,${MACHINE_ID}::uuid,'fidelity','reviewer','[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'2026-01-05T00:00:00Z'::timestamptz,'2026-01-05T00:00:00Z'::timestamptz),
        ('01990000-0000-7000-8000-000000020231'::uuid,${SECOND_SPACE_ID}::uuid,'01990000-0000-7000-8000-000000020232'::uuid,${SECOND_SPACE_RUNS[0]}::uuid,${MACHINE_ID}::uuid,'fidelity','reviewer','[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'2026-01-09T00:00:00Z'::timestamptz,'2026-01-09T00:00:00Z'::timestamptz)`

      await sql.unsafe(`
        ALTER TABLE review_lens FORCE ROW LEVEL SECURITY;
        ALTER TABLE run_score FORCE ROW LEVEL SECURITY;
        ALTER TABLE run FORCE ROW LEVEL SECURITY;
      `)
      for (const statement of migrationSessionStatements()) await sql.unsafe(statement)
      await migrate(drizzle({ client: sql }), { migrationsFolder })
    } finally {
      await sql.close()
    }
  })

  afterAll(() => rmSync(priorMigrations, { recursive: true, force: true }))

  test('numbers populated spaces by all evidence timestamps and advances from each maximum', async () => {
    const sql = new SQL(url!)
    try {
      const assertSpace = async (spaceId: string, expectedIds: readonly string[]) => {
        const rows = (await sql`
          SELECT id::text, evidence_seq FROM run
          WHERE space_id=${spaceId}::uuid ORDER BY evidence_seq
        `) as SequenceRow[]
        expect(rows.map((row) => row.id)).toEqual([...expectedIds])
        const sequences = rows.map((row) => BigInt(row.evidence_seq))
        expect(sequences).toEqual(expectedIds.map((_, index) => BigInt(index + 1)))
        expect(new Set(sequences).size).toBe(sequences.length)
        const [head] = await sql`
          SELECT sequence FROM routing_evidence_head WHERE space_id=${spaceId}::uuid
        `
        expect(BigInt(String(head!.sequence))).toBe(BigInt(expectedIds.length))

        await sql`UPDATE run SET label='post-backfill advance' WHERE id=${expectedIds[0]}::uuid`
        const [advanced] = await sql`
          SELECT evidence_seq FROM run WHERE id=${expectedIds[0]}::uuid
        `
        expect(BigInt(String(advanced!.evidence_seq))).toBe(BigInt(expectedIds.length + 1))
        const [advancedHead] = await sql`
          SELECT sequence FROM routing_evidence_head WHERE space_id=${spaceId}::uuid
        `
        expect(BigInt(String(advancedHead!.sequence))).toBe(BigInt(expectedIds.length + 1))
      }

      await assertSpace(FIRST_SPACE_ID, [
        FIRST_SPACE_RUNS[2],
        FIRST_SPACE_RUNS[0],
        FIRST_SPACE_RUNS[1],
      ])
      await assertSpace(SECOND_SPACE_ID, [SECOND_SPACE_RUNS[1], SECOND_SPACE_RUNS[0]])
    } finally {
      await sql.close()
    }
  })
})
