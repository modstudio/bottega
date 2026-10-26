import type { Transaction } from '@electric-sql/pglite'

export const runTaskReferenceBackfill = '20261026064434_dev_1771_run_task_backfill'

const machineId = '01990000-0000-7000-8000-000000000053'
const matchedRunId = '01990000-0000-7000-8000-000000000054'
const unmatchedRunId = '01990000-0000-7000-8000-000000000055'

export async function seedRunTaskReferenceBackfill(
  transaction: Transaction,
  input: { spaceId: string; userId: string },
): Promise<void> {
  await transaction.exec(`
    INSERT INTO machine (id, user_id, name, registered_at, last_seen)
    VALUES ('${machineId}', '${input.userId}', 'run-task-proof', now(), now());
    ALTER TABLE "run" NO FORCE ROW LEVEL SECURITY;
    INSERT INTO "run"
      (id, space_id, machine_id, started_at, agent, job, prompt_sha, prompt_bytes, prompt_head,
       task_key, probe, status, turn, no_failover, automatic_failover, work_preserved, created_at, updated_at)
    VALUES
      ('${matchedRunId}', '${input.spaceId}', '${machineId}', now(),
       'migration-check', 'proof', 'prompt', 6, 'prompt', 'HUB-1', false, 'ok', 1, false, false, false, now(), now()),
      ('${unmatchedRunId}', '${input.spaceId}', '${machineId}', now(),
       'migration-check', 'proof', 'prompt', 6, 'prompt', 'HUB-MISSING', false, 'ok', 1, false, false, false, now(), now());
    ALTER TABLE "run" FORCE ROW LEVEL SECURITY;
  `)
}

export async function proofRunTaskReferenceBackfill(
  transaction: Transaction,
  matchedTaskId: string,
): Promise<void> {
  await transaction.exec('ALTER TABLE "run" NO FORCE ROW LEVEL SECURITY;')
  const result = await transaction.query<{ id: string; task_id: string | null }>(`
    SELECT id::text AS id, task_id::text AS task_id FROM "run"
    WHERE id IN ('${matchedRunId}', '${unmatchedRunId}')
    ORDER BY id
  `)
  await transaction.exec('ALTER TABLE "run" FORCE ROW LEVEL SECURITY;')
  const expected = [
    { id: matchedRunId, task_id: matchedTaskId },
    { id: unmatchedRunId, task_id: null },
  ]
  if (JSON.stringify(result.rows) !== JSON.stringify(expected)) {
    throw new Error(`DEV-1771 run task_id backfill produced ${JSON.stringify(result.rows)}`)
  }
}
