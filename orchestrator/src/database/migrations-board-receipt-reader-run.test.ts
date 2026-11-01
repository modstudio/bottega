import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { applyMigrations } from './migrations.ts'
import { fixtureProjectRecordId, migratedTestDatabase } from './test-database.fixture.ts'

test('board receipt reader-run backfill resolves local runs and counts non-run or non-local readers as NULL', () => {
  const database = migratedTestDatabase()
  try {
    const projectId = fixtureProjectRecordId(database)
    const runId = newRecordId()
    const messageId = newRecordId()
    const hostedMessageId = newRecordId()
    database
      .query(
        `INSERT INTO run
         (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,turn,project_record_id)
         VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM run),'2026-11-01','codex','implement','sha',1,'proof','ok',1,?)`,
      )
      .run(runId, projectId)
    database
      .query(
        `INSERT INTO board_message
         (record_id,number,kind,purpose,author_kind,author_session,audience,title,body,ack_required,expires_at,created_at)
         VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM board_message),'notice','information','operator',NULL,'operator','proof','proof',0,'2026-11-02','2026-11-01')`,
      )
      .run(messageId)
    database
      .query(
        `INSERT INTO board_receipt
         (record_id,message_record_id,reader_session,audience_at_posting)
         VALUES (?,?,?,1),(?,?,?,1)`,
      )
      .run(newRecordId(), messageId, `run:${runId}`, newRecordId(), messageId, 'session-reader')
    database
      .query(
        `INSERT INTO board_hosted_adoption_receipt
         (message_record_id,reader_session,state,updated_at)
         VALUES (?,?,'uploaded','2026-11-01')`,
      )
      .run(messageId, `run:${runId}`)
    database
      .query(
        `INSERT INTO hosted_board_message_cache(id,kind,revision,payload)
         VALUES (?,'notice','1','{}')`,
      )
      .run(hostedMessageId)
    database
      .query(
        `INSERT INTO hosted_board_receipt_cache
         (record_id,message_id,reader_session,audience_at_posting)
         VALUES (?,?,?,1)`,
      )
      .run(newRecordId(), hostedMessageId, `run:${newRecordId()}`)

    applyMigrations(database)

    expect(
      database
        .query(
          'SELECT reader_session,reader_run_record_id FROM board_receipt WHERE message_record_id=? ORDER BY reader_session',
        )
        .all(messageId),
    ).toEqual([
      { reader_session: `run:${runId}`, reader_run_record_id: runId },
      { reader_session: 'session-reader', reader_run_record_id: null },
    ])
    expect(
      database
        .query(
          'SELECT reader_run_record_id FROM board_hosted_adoption_receipt WHERE message_record_id=?',
        )
        .get(messageId),
    ).toEqual({ reader_run_record_id: runId })
    expect(
      database
        .query(
          'SELECT COUNT(*) AS count FROM hosted_board_receipt_cache WHERE reader_run_record_id IS NULL',
        )
        .get(),
    ).toEqual({ count: 1 })
  } finally {
    database.close()
  }
})
