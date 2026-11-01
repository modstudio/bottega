import type { Transaction } from '@electric-sql/pglite'
import { PLATFORM_SPACE_ID } from '../shared/record/schema.ts'
import { CheckFailure } from './record-migration-failure.ts'

export const boardReaderRunBackfill =
  '20261101151123_dev_2002_board_receipt_reader_run_backfill'
const USER_ID = '01990000-0000-7000-8000-000000000002'
const RUN_ID = '01990000-0000-7000-8000-000000000401'
const MACHINE_ID = '01990000-0000-7000-8000-000000000402'
const MESSAGE_ID = '01990000-0000-7000-8000-000000000403'

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
       'hosted-session-reader',true);
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
  ]
  if (JSON.stringify(result.rows) !== JSON.stringify(expected))
    throw new CheckFailure(
      `DEV-2002 board receipt reader run backfill produced ${JSON.stringify(result.rows)}`,
    )
}
