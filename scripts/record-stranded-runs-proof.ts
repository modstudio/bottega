import type { Transaction } from '@electric-sql/pglite'
import type { MigrationMeta } from 'drizzle-orm/migrator'
import { PLATFORM_SPACE_ID } from '../shared/record/schema.ts'

const strandedRunsMigration = '20261101151500_dev_1994_stranded_runs'

const targetSpaces = new Map([
  ['01a0ab08-26bf-7000-b8bd-d50ee3bdae3b', '01990000-0000-7000-8000-000000001981'],
  ['01a0ab08-26d0-7000-86c3-b81996f2fb1d', '01990000-0000-7000-8000-000000001982'],
  ['01a0ab08-26df-7000-a916-594f80673fb4', '01990000-0000-7000-8000-000000001983'],
])

function listedRuns(migration: MigrationMeta): { runId: string; projectId: string }[] {
  return [...migration.sql.join('\n').matchAll(/\('([0-9a-f-]{36})','([0-9a-f-]{36})'\)/g)].map(
    (match) => ({ runId: match[1]!, projectId: match[2]! }),
  )
}

export async function seedStrandedRunsProof(
  transaction: Transaction,
  migration: MigrationMeta,
): Promise<void> {
  if (migration.name !== strandedRunsMigration) return
  const runs = listedRuns(migration)
  if (runs.length !== 47) throw new Error(`DEV-1994 migration lists ${runs.length} runs, not 47`)
  const identity = (
    await transaction.query<{ machine_id: string; user_id: string }>(`
      SELECT m.id::text machine_id,m.user_id::text user_id FROM machine m ORDER BY m.id LIMIT 1
    `)
  ).rows[0]
  if (!identity) throw new Error('DEV-1994 migration proof has no machine identity')
  await transaction.exec(`
    ALTER TABLE space NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE project NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE run NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE run_score NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE run_exclusion NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE contention NO FORCE ROW LEVEL SECURITY;
  `)
  await transaction.query(
    `UPDATE run SET probe=true
     WHERE space_id=$1 AND NOT probe AND task_id IS NULL AND project_id IS NULL
       AND id<>ALL($2::uuid[])`,
    [PLATFORM_SPACE_ID, runs.map((run) => run.runId)],
  )
  for (const [projectId, spaceId] of targetSpaces) {
    await transaction.query(`INSERT INTO space(id,name,slug,created_at) VALUES($1,$2,$3,now())`, [
      spaceId,
      `DEV-1994 ${projectId}`,
      `dev-1994-${projectId.slice(-4)}`,
    ])
    await transaction.query(
      `INSERT INTO project(id,space_id,name,created_at) VALUES($1,$2,$3,now())`,
      [projectId, spaceId, `dev-1994-${projectId.slice(-4)}`],
    )
  }
  for (const { runId } of runs) {
    await transaction.query(
      `INSERT INTO run(
        id,space_id,machine_id,started_by_user_id,started_at,agent,job,prompt_sha,
        prompt_bytes,prompt_head,probe,status,turn,no_failover,automatic_failover,
        work_preserved,created_at,updated_at
      ) VALUES($1,$2,$3,$4,now(),'proof','write','sha',1,'proof',false,'ok',0,false,false,false,now(),now())`,
      [runId, PLATFORM_SPACE_ID, identity.machine_id, identity.user_id],
    )
    await transaction.query(
      `INSERT INTO run_score(run_id,space_id,delivery,scored_at,scored_by,updated_at)
       VALUES($1,$2,'none',now(),'proof',now())`,
      [runId, PLATFORM_SPACE_ID],
    )
    await transaction.query(
      `INSERT INTO run_exclusion(run_id,space_id,reason,excluded_at) VALUES($1,$2,'proof',now())`,
      [runId, PLATFORM_SPACE_ID],
    )
    await transaction.query(
      `INSERT INTO contention(
        id,space_id,machine_id,at,resource_kind,resource_key,event_kind,run_id,created_at,updated_at
      ) VALUES(gen_random_uuid(),$1,$2,now(),'proof',$3::text,'wait',$3::uuid,now(),now())`,
      [PLATFORM_SPACE_ID, identity.machine_id, runId],
    )
  }
  await transaction.exec(`
    ALTER TABLE contention FORCE ROW LEVEL SECURITY;
    ALTER TABLE run_exclusion FORCE ROW LEVEL SECURITY;
    ALTER TABLE run_score FORCE ROW LEVEL SECURITY;
    ALTER TABLE run FORCE ROW LEVEL SECURITY;
    ALTER TABLE project FORCE ROW LEVEL SECURITY;
    ALTER TABLE space FORCE ROW LEVEL SECURITY;
  `)
}

export async function proofStrandedRunsMigration(
  transaction: Transaction,
  migration: MigrationMeta,
): Promise<void> {
  if (migration.name !== strandedRunsMigration) return
  const runs = listedRuns(migration)
  await transaction.exec(`
    ALTER TABLE project NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE run NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE run_score NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE run_exclusion NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE contention NO FORCE ROW LEVEL SECURITY;
  `)
  const result = await transaction.query<{ moved: number }>(
    `
    SELECT count(*)::int moved FROM run r
    JOIN run_score s ON s.run_id=r.id AND s.space_id=r.space_id
    JOIN run_exclusion e ON e.run_id=r.id AND e.space_id=r.space_id
    JOIN contention c ON c.run_id=r.id AND c.space_id=r.space_id
    JOIN project p ON p.id=r.project_id AND p.space_id=r.space_id
    WHERE r.id=ANY($1::uuid[])
  `,
    [runs.map((run) => run.runId)],
  )
  await transaction.exec(`
    ALTER TABLE contention FORCE ROW LEVEL SECURITY;
    ALTER TABLE run_exclusion FORCE ROW LEVEL SECURITY;
    ALTER TABLE run_score FORCE ROW LEVEL SECURITY;
    ALTER TABLE run FORCE ROW LEVEL SECURITY;
    ALTER TABLE project FORCE ROW LEVEL SECURITY;
  `)
  if (result.rows[0]?.moved !== 47)
    throw new Error(`DEV-1994 migration proof moved ${result.rows[0]?.moved ?? 0} complete graphs`)
}
