import type { Transaction } from '@electric-sql/pglite'
import { PLATFORM_SPACE_ID } from '../shared/record/schema.ts'
import { CheckFailure } from './record-migration-failure.ts'

export const boardReaderRunBackfill = '20261101151123_dev_2002_board_receipt_reader_run_backfill'
const USER_ID = '01990000-0000-7000-8000-000000000002'
const RUN_ID = '01990000-0000-7000-8000-000000000401'
const MISSING_RUN_ID = '01990000-0000-7000-8000-000000000406'
const MACHINE_ID = '01990000-0000-7000-8000-000000000402'
const MESSAGE_ID = '01990000-0000-7000-8000-000000000403'
const ROOT_ID = '01990000-0000-7000-8000-000000000021'
const REPLY_ID = '01990000-0000-7000-8000-000000000022'
const REPLY_AUTHOR_ID = '01990000-0000-7000-8000-000000000023'
const QUESTION_ID = '01990000-0000-7000-8000-000000000027'

export async function seedBoardThreadAuthorBackfill(transaction: Transaction): Promise<void> {
  await transaction.exec(`
    INSERT INTO "user" (id, email, name, created_at) VALUES
      ('${REPLY_AUTHOR_ID}', 'board-backfill-reply@example.test',
       'Board backfill reply author', now());
    ALTER TABLE board_message NO FORCE ROW LEVEL SECURITY;
    INSERT INTO board_message
      (id, author_user_id, kind, audience, title, body, ack_required, expires_at, created_at)
    VALUES
      ('${ROOT_ID}', '${USER_ID}', 'notice', 'operator',
       'Board backfill root', 'root', false, now() + interval '1 day', now()),
      ('${QUESTION_ID}', '${USER_ID}', 'question', 'operator',
       'Board backfill question', 'question', false, now() + interval '1 day', now());
    INSERT INTO board_message
      (id, author_user_id, kind, thread_root_id, body, ack_required, created_at)
    VALUES
      ('${REPLY_ID}', '${REPLY_AUTHOR_ID}', 'reply', '${ROOT_ID}', 'reply', false, now());
    ALTER TABLE board_message FORCE ROW LEVEL SECURITY;
  `)
}

export async function proofBoardPurposeBackfill(transaction: Transaction): Promise<void> {
  await transaction.exec('ALTER TABLE board_message NO FORCE ROW LEVEL SECURITY;')
  const result = await transaction.query<{ kind: string; purpose: string | null }>(`
    SELECT kind,purpose FROM board_message
    WHERE id IN ('${ROOT_ID}','${QUESTION_ID}','${REPLY_ID}') ORDER BY kind
  `)
  await transaction.exec('ALTER TABLE board_message FORCE ROW LEVEL SECURITY;')
  const expected = [
    { kind: 'notice', purpose: 'information' },
    { kind: 'question', purpose: 'request' },
    { kind: 'reply', purpose: null },
  ]
  if (JSON.stringify(result.rows) !== JSON.stringify(expected))
    throw new CheckFailure(
      `DEV-1217 board purpose backfill produced ${JSON.stringify(result.rows)}`,
    )
}

export async function proofBoardThreadAuthorBackfill(transaction: Transaction): Promise<void> {
  await transaction.exec('ALTER TABLE board_message NO FORCE ROW LEVEL SECURITY;')
  const result = await transaction.query<{ invalid: number }>(`
    SELECT count(*)::int AS invalid
    FROM board_message AS reply
    LEFT JOIN board_message AS root ON root.id = reply.thread_root_id
    WHERE reply.kind = 'reply'
      AND reply.thread_root_author_user_id IS DISTINCT FROM root.author_user_id
  `)
  await transaction.exec('ALTER TABLE board_message FORCE ROW LEVEL SECURITY;')
  if (result.rows[0]?.invalid !== 0)
    throw new CheckFailure('DEV-1217 board reply anchors do not match their root authors')
}

export async function seedBoardReaderRunBackfill(transaction: Transaction): Promise<void> {
  await transaction.exec(`
    ALTER TABLE board_message NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE board_receipt NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE run NO FORCE ROW LEVEL SECURITY;
    INSERT INTO machine (id,user_id,name,registered_at,last_seen)
    VALUES ('${MACHINE_ID}','${USER_ID}','reader-run-proof',now(),now());
    INSERT INTO run
      (id,space_id,machine_id,started_by_user_id,started_at,agent,job,prompt_sha,prompt_bytes,
       prompt_head,probe,status,turn,no_failover,automatic_failover,work_preserved,created_at,updated_at)
    VALUES
      ('${RUN_ID}','${PLATFORM_SPACE_ID}','${MACHINE_ID}','${USER_ID}',now(),'codex','implement',
       'sha',1,'proof',false,'ok',1,false,false,false,now(),now());
    INSERT INTO board_message
      (id,author_user_id,kind,purpose,audience,title,body,ack_required,expires_at,created_at)
    VALUES
      ('${MESSAGE_ID}','${USER_ID}','notice','information','operator','Reader run backfill',
       'proof',false,now() + interval '1 day',now());
    INSERT INTO board_receipt
      (id,message_id,reader_user_id,reader_session,audience_at_posting)
    VALUES
      ('01990000-0000-7000-8000-000000000404','${MESSAGE_ID}','${USER_ID}',
       'run:${RUN_ID}',true),
      ('01990000-0000-7000-8000-000000000405','${MESSAGE_ID}','${USER_ID}',
       'hosted-session-reader',true),
      ('01990000-0000-7000-8000-000000000407','${MESSAGE_ID}','${USER_ID}',
       'run:${MISSING_RUN_ID}',true);
    ALTER TABLE run FORCE ROW LEVEL SECURITY;
    ALTER TABLE board_receipt FORCE ROW LEVEL SECURITY;
    ALTER TABLE board_message FORCE ROW LEVEL SECURITY;
  `)
}

export async function proofBoardReaderRunBackfill(transaction: Transaction): Promise<void> {
  await transaction.exec('ALTER TABLE board_receipt NO FORCE ROW LEVEL SECURITY;')
  const result = await transaction.query<{
    reader_session: string
    reader_run_record_id: string | null
  }>(`
    SELECT reader_session,reader_run_record_id::text AS reader_run_record_id
    FROM board_receipt WHERE message_id='${MESSAGE_ID}' ORDER BY reader_session
  `)
  await transaction.exec('ALTER TABLE board_receipt FORCE ROW LEVEL SECURITY;')
  const expected = [
    { reader_session: 'hosted-session-reader', reader_run_record_id: null },
    { reader_session: `run:${RUN_ID}`, reader_run_record_id: RUN_ID },
    { reader_session: `run:${MISSING_RUN_ID}`, reader_run_record_id: MISSING_RUN_ID },
  ]
  if (JSON.stringify(result.rows) !== JSON.stringify(expected))
    throw new CheckFailure(
      `DEV-2002 board receipt reader run backfill produced ${JSON.stringify(result.rows)}`,
    )
}
