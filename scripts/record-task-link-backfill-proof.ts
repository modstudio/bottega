import type { Transaction } from '@electric-sql/pglite'
import { CheckFailure } from './record-migration-failure.ts'

export const taskLinkBackfill = '20261026112733_dev_1773_task_link_backfill'

const ids = {
  machine: '01990000-0000-7000-8000-000000001783',
  task: '01990000-0000-7000-8000-000000001784',
  deletedTask: '01990000-0000-7000-8000-000000001785',
  otherSpace: '01990000-0000-7000-8000-000000001786',
  otherSpaceTask: '01990000-0000-7000-8000-000000001787',
  question: '01990000-0000-7000-8000-000000001788',
  run: '01990000-0000-7000-8000-000000001789',
  email: '01990000-0000-7000-8000-00000000178a',
  deletedQuestion: '01990000-0000-7000-8000-00000000178b',
  otherSpaceQuestion: '01990000-0000-7000-8000-00000000178c',
} as const

const matchedKey = 'DEV-1773-MIGRATION-PROOF'
const deletedKey = 'DEV-1773-DELETED-PROOF'
const otherSpaceKey = 'DEV-1773-OTHER-SPACE-PROOF'

export async function seedTaskLinkBackfill(
  transaction: Transaction,
  input: { spaceId: string; userId: string },
): Promise<void> {
  await transaction.exec(`
    INSERT INTO machine (id, user_id, name, registered_at, last_seen)
    VALUES ('${ids.machine}', '${input.userId}', 'task-link-backfill-proof', now(), now());
    ALTER TABLE space NO FORCE ROW LEVEL SECURITY;
    INSERT INTO space (id, name, slug, created_at)
    VALUES ('${ids.otherSpace}', 'DEV-1773 other-space proof', 'dev-1773-other-space-proof', now());
    ALTER TABLE space FORCE ROW LEVEL SECURITY;
    ALTER TABLE hub_task NO FORCE ROW LEVEL SECURITY;
    INSERT INTO hub_task
      (id, space_id, project_name, key, project, title, status, status_category, source,
       first_seen, last_seen, created_at, updated_at, deleted_at)
    VALUES
      ('${ids.task}', '${input.spaceId}', 'task-link-proof', '${matchedKey}',
       'task-link-proof', 'matched', 'active', 'active', 'local', now(), now(), now(), now(), NULL),
      ('${ids.deletedTask}', '${input.spaceId}', 'task-link-proof', '${deletedKey}',
       'task-link-proof', 'deleted', 'done', 'done', 'local', now(), now(), now(), now(), now()),
      ('${ids.otherSpaceTask}', '${ids.otherSpace}', 'task-link-proof', '${otherSpaceKey}',
       'task-link-proof', 'other space', 'active', 'active', 'local', now(), now(), now(), now(), NULL);
    ALTER TABLE hub_task FORCE ROW LEVEL SECURITY;
    ALTER TABLE question NO FORCE ROW LEVEL SECURITY;
    INSERT INTO question
      (id, space_id, workflow_key, machine_id, revision, asked_at, question, withheld_fields,
       created_at, updated_at)
    VALUES
      ('${ids.question}', '${input.spaceId}', '${matchedKey}', '${ids.machine}', 1, now(),
       'matched?', '[]'::jsonb, now(), now()),
      ('${ids.deletedQuestion}', '${input.spaceId}', '${deletedKey}', '${ids.machine}', 1, now(),
       'deleted?', '[]'::jsonb, now(), now()),
      ('${ids.otherSpaceQuestion}', '${input.spaceId}', '${otherSpaceKey}', '${ids.machine}', 1, now(),
       'other space?', '[]'::jsonb, now(), now());
    ALTER TABLE question FORCE ROW LEVEL SECURITY;
    ALTER TABLE "run" NO FORCE ROW LEVEL SECURITY;
    INSERT INTO "run"
      (id, space_id, machine_id, started_at, agent, job, prompt_sha, prompt_bytes, prompt_head,
       task_key, probe, status, turn, no_failover, automatic_failover, work_preserved,
       created_at, updated_at)
    VALUES
      ('${ids.run}', '${input.spaceId}', '${ids.machine}', now(), 'migration-check', 'proof',
       'prompt', 6, 'prompt', '${matchedKey}', false, 'ok', 1, false, false, false, now(), now());
    ALTER TABLE "run" FORCE ROW LEVEL SECURITY;
    ALTER TABLE operator_waiting_email NO FORCE ROW LEVEL SECURITY;
    INSERT INTO operator_waiting_email
      (id, space_id, user_id, kind, item_id, item_record_id, episode, project, task_key,
       question, options, waiting_since, link, status, attempts, created_at, updated_at)
    VALUES
      ('${ids.email}', '${input.spaceId}', '${input.userId}', 'workflow', 1773, '${ids.run}',
       'migration-proof', 'task-link-proof', '${matchedKey}', 'matched?', '[]'::jsonb, now(),
       'http://localhost', 'intent', 1, now(), now());
    ALTER TABLE operator_waiting_email FORCE ROW LEVEL SECURITY;
  `)
}

export async function proofTaskLinkBackfill(
  transaction: Transaction,
  input: { spaceId: string; userId: string },
): Promise<void> {
  await transaction.exec(`
    SELECT set_config('app.space_id', '${input.spaceId}', true);
    SELECT set_config('app.user_id', '${input.userId}', true);
  `)
  const result = await transaction.query<{ kind: string; id: string; task_id: string | null }>(`
    SELECT 'email' AS kind, id::text AS id, task_id::text AS task_id
    FROM operator_waiting_email WHERE id = '${ids.email}'
    UNION ALL
    SELECT 'question', id::text, workflow_task_id::text
    FROM question WHERE id IN ('${ids.question}', '${ids.deletedQuestion}', '${ids.otherSpaceQuestion}')
    UNION ALL
    SELECT 'run', id::text, task_id::text FROM "run" WHERE id = '${ids.run}'
    ORDER BY kind, id
  `)
  await transaction.exec(`
    SELECT set_config('app.space_id', '', true);
    SELECT set_config('app.user_id', '', true);
  `)
  const expected = [
    { kind: 'email', id: ids.email, task_id: ids.task },
    { kind: 'question', id: ids.question, task_id: ids.task },
    { kind: 'question', id: ids.deletedQuestion, task_id: null },
    { kind: 'question', id: ids.otherSpaceQuestion, task_id: null },
    { kind: 'run', id: ids.run, task_id: ids.task },
  ]
  if (JSON.stringify(result.rows) !== JSON.stringify(expected)) {
    throw new CheckFailure(`DEV-1773 task-link backfill produced ${JSON.stringify(result.rows)}`)
  }
}
