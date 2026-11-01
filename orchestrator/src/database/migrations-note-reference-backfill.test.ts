import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { applyMigrations, migrationJournal } from './migrations.ts'
import { migrationBoundaryTestDatabase } from './test-database.fixture.ts'

function pendingMigrationsFrom(tag: string): string[] {
  const journal = migrationJournal()
  return journal.slice(journal.findIndex((entry) => entry.tag === tag)).map((entry) => entry.tag)
}

test('note UUID reference migration preserves rows and turns old integers into display labels', () => {
  const database = migrationBoundaryTestDatabase('0091_note_uuid_references')
  try {
    const run = database
      .query(
        `INSERT INTO run (record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
         VALUES ('${newRecordId()}','2026-10-09','codex','implement','sha',1,'prompt','ok') RETURNING id`,
      )
      .get() as { id: number }
    database
      .query(
        `INSERT INTO worker_note_request
         (run_id,text,requested_at,finished_at,status,note_id,candidate_ids)
         VALUES (?,'finding','2026-10-09','2026-10-09','filed',71,'[8,13]')`,
      )
      .run(run.id)
    database
      .query(
        `INSERT INTO board_message
         (kind,author_kind,author_session,audience,title,body,ack_required,expires_at,created_at,note_id)
         VALUES ('question','architect','author','operator','Title','Body',0,'2026-10-10','2026-10-09',72)`,
      )
      .run()
    const revisionId = '01990000-0000-7000-8000-000000000091'
    database.exec(
      `INSERT INTO doc (id,scope,slug,title,body,created_at,updated_at,record_id) VALUES (91,'global','filed-doc','Filed doc','Body','2026-10-09','2026-10-09','01990000-0000-7000-8000-000000000090'); INSERT INTO doc_revision (id,doc_id,scope,slug,op,title,body,author,reason,at,record_id) VALUES (1,91,'global','filed-doc','create','Filed doc','Body','tester','seed','2026-10-09','${revisionId}')`,
    )
    database
      .query(
        `INSERT INTO question (record_id,run_id,asked_at,question,filed_as,filed_ref)
         VALUES ('${newRecordId()}',?,'2026-10-09','Canon?','canon-proposal','73'),
                ('${newRecordId()}',?,'2026-10-09','Doc?','doc',?)`,
      )
      .run(run.id, run.id, `12@${revisionId}`)

    expect(
      applyMigrations(database, undefined, {
        migration: '0130_doc_uuid_key',
        action: (current) => {
          current
            .query("UPDATE question SET filed_record_id=? WHERE filed_as='doc'")
            .run(revisionId)
        },
      }),
    ).toEqual(pendingMigrationsFrom('0091_note_uuid_references'))
    expect(
      database
        .query(
          `SELECT same_as,note_record_id,note_label,candidate_ids,candidate_labels
           FROM worker_note_request`,
        )
        .get(),
    ).toEqual({
      same_as: null,
      note_record_id: null,
      note_label: '71',
      candidate_ids: '[]',
      candidate_labels: '["8","13"]',
    })
    expect(database.query('SELECT note_record_id,note_label FROM board_message').get()).toEqual({
      note_record_id: null,
      note_label: '72',
    })
    expect(
      database
        .query(
          `SELECT filed_as,filed_ref,filed_record_id,filed_label
           FROM question ORDER BY number`,
        )
        .all(),
    ).toEqual([
      {
        filed_as: 'canon-proposal',
        filed_ref: null,
        filed_record_id: null,
        filed_label: '73',
      },
      {
        filed_as: 'doc',
        filed_ref: 'global/_/filed-doc@1',
        filed_record_id: revisionId,
        filed_label: null,
      },
    ])
    expect(
      database
        .query(`SELECT name FROM pragma_table_info('worker_note_request') WHERE name='note_id'`)
        .get(),
    ).toBeNull()
    expect(
      database
        .query(`SELECT name FROM pragma_table_info('board_message') WHERE name='note_id'`)
        .get(),
    ).toBeNull()
  } finally {
    database.close()
  }
})
