import type { Transaction } from '@electric-sql/pglite'

export const runOwnerBackfill = '20261026121032_dev_1774_run_owner_backfill'
export const runOwnerRequired = '20261026121049_dev_1774_run_owner_required'

const machineId = '01990000-0000-7000-8000-000000000070'
const machineUserId = '01990000-0000-7000-8000-000000000071'
const existingOwnerId = '01990000-0000-7000-8000-000000000072'
const ownerlessRunId = '01990000-0000-7000-8000-000000000073'
const ownedRunId = '01990000-0000-7000-8000-000000000074'

export async function seedRunOwnerBackfill(
  transaction: Transaction,
  spaceId: string,
): Promise<void> {
  await transaction.exec(`
    INSERT INTO "user" (id, email, name, created_at) VALUES
      ('${machineUserId}', 'dev-1774-machine@example.test', 'DEV-1774 machine user', now()),
      ('${existingOwnerId}', 'dev-1774-owner@example.test', 'DEV-1774 existing owner', now());
    INSERT INTO machine (id, user_id, name, registered_at, last_seen)
    VALUES ('${machineId}', '${machineUserId}', 'run-owner-proof', now(), now());
    ALTER TABLE "run" NO FORCE ROW LEVEL SECURITY;
    INSERT INTO "run"
      (id, space_id, machine_id, started_by_user_id, started_at, agent, job, prompt_sha,
       prompt_bytes, prompt_head, probe, status, turn, no_failover, automatic_failover,
       work_preserved, created_at, updated_at)
    VALUES
      ('${ownerlessRunId}', '${spaceId}', '${machineId}', NULL, now(), 'migration-check',
       'proof', 'prompt', 6, 'prompt', false, 'ok', 1, false, false, false, now(), now()),
      ('${ownedRunId}', '${spaceId}', '${machineId}', '${existingOwnerId}', now(),
       'migration-check', 'proof', 'prompt', 6, 'prompt', false, 'ok', 1, false, false,
       false, now(), now());
    ALTER TABLE "run" FORCE ROW LEVEL SECURITY;
  `)
}

export async function proofRunOwnerRequired(transaction: Transaction): Promise<void> {
  await transaction.exec('ALTER TABLE "run" NO FORCE ROW LEVEL SECURITY;')
  const owners = await transaction.query<{ id: string; started_by_user_id: string }>(`
    SELECT id::text AS id, started_by_user_id::text AS started_by_user_id
    FROM "run" WHERE id IN ('${ownerlessRunId}', '${ownedRunId}') ORDER BY id
  `)
  await transaction.exec('ALTER TABLE "run" FORCE ROW LEVEL SECURITY;')
  const expected = [
    { id: ownerlessRunId, started_by_user_id: machineUserId },
    { id: ownedRunId, started_by_user_id: existingOwnerId },
  ]
  if (JSON.stringify(owners.rows) !== JSON.stringify(expected)) {
    throw new Error(`DEV-1774 run owner backfill produced ${JSON.stringify(owners.rows)}`)
  }
  const column = await transaction.query<{ is_nullable: string }>(`
    SELECT is_nullable FROM information_schema.columns
    WHERE table_schema='public' AND table_name='run' AND column_name='started_by_user_id'
  `)
  if (column.rows[0]?.is_nullable !== 'NO') {
    throw new Error('DEV-1774 run started_by_user_id remains nullable')
  }
  const force = await transaction.query<{ relforcerowsecurity: boolean }>(`
    SELECT relforcerowsecurity FROM pg_class
    WHERE relnamespace='public'::regnamespace AND relname='run'
  `)
  if (force.rows[0]?.relforcerowsecurity !== true) {
    throw new Error('DEV-1774 run FORCE ROW LEVEL SECURITY was not restored')
  }
}
