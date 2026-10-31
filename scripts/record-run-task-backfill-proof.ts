import type { Transaction } from '@electric-sql/pglite'
import { CheckFailure } from './record-migration-failure.ts'

export const runTaskReferenceBackfill = '20261026064434_dev_1771_run_task_backfill'

const machineId = '01990000-0000-7000-8000-000000000053'
const matchedRunId = '01990000-0000-7000-8000-000000000054'
const unmatchedRunId = '01990000-0000-7000-8000-000000000055'
const matchedTaskId = '01990000-0000-7000-8000-000000000056'
const otherSpaceId = '01990000-0000-7000-8000-000000000057'
const otherSpaceTaskId = '01990000-0000-7000-8000-000000000058'
const matchedTaskKey = 'DEV-1771-PROOF'
const unmatchedTaskKey = 'HUB-MISSING'

export async function seedRunTaskReferenceBackfill(
  transaction: Transaction,
  input: { spaceId: string; userId: string },
): Promise<void> {
  await transaction.exec(`
    INSERT INTO machine (id, user_id, name, registered_at, last_seen)
    VALUES ('${machineId}', '${input.userId}', 'run-task-proof', now(), now());
    ALTER TABLE space NO FORCE ROW LEVEL SECURITY;
    INSERT INTO space (id, name, slug, created_at)
    VALUES ('${otherSpaceId}', 'DEV-1771 other-space proof', 'dev-1771-other-space-proof', now());
    ALTER TABLE space FORCE ROW LEVEL SECURITY;
    ALTER TABLE hub_task NO FORCE ROW LEVEL SECURITY;
    INSERT INTO hub_task
      (id, space_id, project_name, key, project, source, first_seen, last_seen, created_at, updated_at)
    VALUES
      ('${matchedTaskId}', '${input.spaceId}', 'run-task-proof', '${matchedTaskKey}',
       'run-task-proof', 'local', now(), now(), now(), now()),
      ('${otherSpaceTaskId}', '${otherSpaceId}', 'run-task-proof', '${unmatchedTaskKey}',
       'run-task-proof', 'local', now(), now(), now(), now());
    ALTER TABLE hub_task FORCE ROW LEVEL SECURITY;
    ALTER TABLE "run" NO FORCE ROW LEVEL SECURITY;
    INSERT INTO "run"
      (id, space_id, machine_id, started_at, agent, job, prompt_sha, prompt_bytes, prompt_head,
       task_key, probe, status, turn, no_failover, automatic_failover, work_preserved, created_at, updated_at)
    VALUES
      ('${matchedRunId}', '${input.spaceId}', '${machineId}', now(),
       'migration-check', 'proof', 'prompt', 6, 'prompt', '${matchedTaskKey}', false, 'ok', 1, false, false, false, now(), now()),
      ('${unmatchedRunId}', '${input.spaceId}', '${machineId}', now(),
       'migration-check', 'proof', 'prompt', 6, 'prompt', '${unmatchedTaskKey}', false, 'ok', 1, false, false, false, now(), now());
    ALTER TABLE "run" FORCE ROW LEVEL SECURITY;
  `)
}

export async function proofRunTaskReferenceBackfill(transaction: Transaction): Promise<void> {
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
    throw new CheckFailure(`DEV-1771 run task_id backfill produced ${JSON.stringify(result.rows)}`)
  }
}
