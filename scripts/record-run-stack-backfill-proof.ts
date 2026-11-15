import type { Transaction } from '@electric-sql/pglite'
import { CheckFailure } from './record-migration-failure.ts'

export const runStackBackfill = '20261115023817_dev_2303_run_stack_backfill'

const userId = '01990000-0000-7000-8000-000000000090'
const machineId = '01990000-0000-7000-8000-000000000091'
const stackedProjectId = '01990000-0000-7000-8000-000000000092'
const blankProjectId = '01990000-0000-7000-8000-000000000093'
const nullStackRunId = '01990000-0000-7000-8000-000000000094'
const blankStackRunId = '01990000-0000-7000-8000-000000000095'
const blankProjectRunId = '01990000-0000-7000-8000-000000000096'

export async function seedRunStackBackfill(
  transaction: Transaction,
  spaceId: string,
): Promise<void> {
  await transaction.exec(`
    INSERT INTO "user" (id, email, name, created_at)
    VALUES ('${userId}', 'dev-2303-run-stack@example.test', 'DEV-2303 run stack', now());
    INSERT INTO machine (id, user_id, name, registered_at, last_seen)
    VALUES ('${machineId}', '${userId}', 'run-stack-proof', now(), now());
    ALTER TABLE project NO FORCE ROW LEVEL SECURITY;
    INSERT INTO project (id, space_id, name, stack, created_at) VALUES
      ('${stackedProjectId}', '${spaceId}', 'run-stack-proof', ' bun ', now()),
      ('${blankProjectId}', '${spaceId}', 'run-stack-blank-proof', ' ', now());
    ALTER TABLE project FORCE ROW LEVEL SECURITY;
    ALTER TABLE "run" NO FORCE ROW LEVEL SECURITY;
    INSERT INTO "run"
      (id, evidence_seq, space_id, project_id, machine_id, started_by_user_id, started_at,
       agent, job, prompt_sha, prompt_bytes, prompt_head, probe, status, turn, stack,
       no_failover, automatic_failover, work_preserved, created_at, updated_at)
    VALUES
      ('${nullStackRunId}', 990094, '${spaceId}', '${stackedProjectId}', '${machineId}',
       '${userId}', now(), 'migration-check', 'proof', 'prompt', 6, 'prompt', false, 'ok', 1,
       NULL, false, false, false, now(), now()),
      ('${blankStackRunId}', 990095, '${spaceId}', '${stackedProjectId}', '${machineId}',
       '${userId}', now(), 'migration-check', 'proof', 'prompt', 6, 'prompt', false, 'ok', 1,
       '', false, false, false, now(), now()),
      ('${blankProjectRunId}', 990096, '${spaceId}', '${blankProjectId}', '${machineId}',
       '${userId}', now(), 'migration-check', 'proof', 'prompt', 6, 'prompt', false, 'ok', 1,
       NULL, false, false, false, now(), now());
    ALTER TABLE "run" FORCE ROW LEVEL SECURITY;
  `)
}

export async function proofRunStackBackfill(transaction: Transaction): Promise<void> {
  await transaction.exec('ALTER TABLE "run" NO FORCE ROW LEVEL SECURITY;')
  const stacks = await transaction.query<{ id: string; stack: string | null }>(`
    SELECT id::text AS id, stack FROM "run"
    WHERE id IN ('${nullStackRunId}', '${blankStackRunId}', '${blankProjectRunId}')
    ORDER BY id
  `)
  await transaction.exec('ALTER TABLE "run" FORCE ROW LEVEL SECURITY;')
  const expected = [
    { id: nullStackRunId, stack: ' bun ' },
    { id: blankStackRunId, stack: ' bun ' },
    { id: blankProjectRunId, stack: null },
  ]
  if (JSON.stringify(stacks.rows) !== JSON.stringify(expected)) {
    throw new CheckFailure(`DEV-2303 run stack backfill produced ${JSON.stringify(stacks.rows)}`)
  }
}
