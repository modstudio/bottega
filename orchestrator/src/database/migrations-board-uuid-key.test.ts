import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { nextEntityNumber } from './entity-number.ts'
import { applyMigrations, applyMigrationsBefore } from './migrations.ts'

const TABLES = [
  'board_claim',
  'board_message',
  'board_message_tag',
  'board_receipt',
  'board_reach_delivery',
  'board_reach_recording_failure',
] as const

const count = (database: Database, table: string) =>
  database.query<{ n: number }, []>(`SELECT COUNT(*) n FROM ${table}`).get()!.n

test('board UUID-key migration preserves rows, relationships, cascades, and message numbers', () => {
  const database = new Database(':memory:')
  database.exec('PRAGMA foreign_keys=ON')
  try {
    applyMigrationsBefore(database, '0127_board_uuid_key')
    const ids = {
      firstClaim: newRecordId(),
      claim: newRecordId(),
      root: newRecordId(),
      reply: newRecordId(),
      tag: newRecordId(),
      receipt: newRecordId(),
      reach: newRecordId(),
      failure: newRecordId(),
    }
    database
      .query(`INSERT INTO board_claim(id,record_id,project,subject_kind,subject_value,holder_kind,duration_ms,taken_at,renewed_at,lapses_at)
        VALUES (31,?,?,'task','DEV-1214','operator',1000,'a','a','z')`)
      .run(ids.firstClaim, PLATFORM_SLUG)
    database
      .query(`INSERT INTO board_claim(id,record_id,project,subject_kind,subject_value,holder_kind,duration_ms,taken_at,renewed_at,lapses_at,superseded_by_claim_id)
        VALUES (32,?,?,'resource','board','operator',1000,'b','b','z',31)`)
      .run(ids.claim, PLATFORM_SLUG)
    database
      .query(`INSERT INTO board_message(id,record_id,kind,author_kind,audience,title,body,ack_required,expires_at,created_at,claim_id)
        VALUES (41,?,'question','operator','operator','title','body',0,'z','a',32)`)
      .run(ids.root)
    database
      .query(`INSERT INTO board_message(id,record_id,kind,author_kind,body,ack_required,created_at,thread_root_id)
        VALUES (42,?,'reply','operator','reply',0,'b',41)`)
      .run(ids.reply)
    database
      .query(
        "UPDATE board_message SET accepted_reply_id=42,accepted_by='operator',accepted_at='c' WHERE id=41",
      )
      .run()
    database
      .query(
        "INSERT INTO board_message_tag(message_id,kind,value,origin,record_id) VALUES (41,'task','DEV-1214','sender',?)",
      )
      .run(ids.tag)
    database
      .query(
        "INSERT INTO board_receipt(message_id,reader_session,audience_at_posting,record_id) VALUES (41,'operator',1,?)",
      )
      .run(ids.receipt)
    database
      .query(`INSERT INTO board_reach_delivery(message_source,message_id,reader_session,reader_project,delivery_point,blocked_stop,audience,acknowledgement_required,posted_at,session_started_at,posting_timing,concern,recorded_at,record_id)
        VALUES ('local','41','operator',?,'session-start',0,'operator',0,'a','a','after-session','concerned','a',?)`)
      .run(PLATFORM_SLUG, ids.reach)
    database
      .query("INSERT INTO board_reach_recording_failure(recorded_at,record_id) VALUES ('a',?)")
      .run(ids.failure)
    database.query("UPDATE sqlite_sequence SET seq=80 WHERE name='board_message'").run()

    const before = new Map(TABLES.map((table) => [table, count(database, table)]))
    expect(applyMigrations(database)).toContain('0127_board_uuid_key')
    for (const [table, rows] of before) expect(count(database, table), table).toBe(rows)
    expect(
      database
        .query(
          'SELECT number,claim_record_id,accepted_reply_record_id FROM board_message WHERE record_id=?',
        )
        .get(ids.root),
    ).toEqual({
      number: 41,
      claim_record_id: ids.claim,
      accepted_reply_record_id: ids.reply,
    })
    expect(
      database
        .query('SELECT thread_root_record_id FROM board_message WHERE record_id=?')
        .get(ids.reply),
    ).toEqual({ thread_root_record_id: ids.root })
    expect(
      database
        .query('SELECT superseded_by_claim_record_id FROM board_claim WHERE record_id=?')
        .get(ids.claim),
    ).toEqual({ superseded_by_claim_record_id: ids.firstClaim })
    expect(
      database.query('SELECT record_id,message_record_id FROM board_message_tag').get(),
    ).toEqual({
      record_id: ids.tag,
      message_record_id: ids.root,
    })
    expect(database.query('SELECT record_id,message_record_id FROM board_receipt').get()).toEqual({
      record_id: ids.receipt,
      message_record_id: ids.root,
    })
    expect(
      database.query('SELECT record_id,message_record_id FROM board_reach_delivery').get(),
    ).toEqual({
      record_id: ids.reach,
      message_record_id: ids.root,
    })
    expect(database.query('SELECT record_id FROM board_reach_recording_failure').get()).toEqual({
      record_id: ids.failure,
    })
    expect(database.query('PRAGMA foreign_key_check').all()).toEqual([])
    expect(
      database
        .query("SELECT last_number FROM entity_number_counter WHERE entity='board_message'")
        .get(),
    ).toEqual({ last_number: 80 })
    expect(nextEntityNumber(database, 'board_message')).toBe(81)
    database.query('DELETE FROM board_message WHERE record_id=?').run(ids.root)
    expect(count(database, 'board_message_tag')).toBe(0)
    expect(count(database, 'board_receipt')).toBe(0)
    expect(
      database.query('SELECT record_id FROM board_message WHERE record_id=?').get(ids.reply),
    ).toBeNull()
  } finally {
    database.close()
  }
})

test('board UUID-key migration reports every orphan together and leaves the old schema unchanged', () => {
  const database = new Database(':memory:')
  try {
    applyMigrationsBefore(database, '0127_board_uuid_key')
    database.exec('PRAGMA foreign_keys=OFF')
    database.exec(`
      INSERT INTO board_claim(record_id,project,subject_kind,subject_value,holder_kind,duration_ms,taken_at,renewed_at,lapses_at,superseded_by_claim_id)
      VALUES ('01990000-0000-7000-8000-000000000001','p','task','T-1','operator',1,'a','a','z',999);
      INSERT INTO board_message(record_id,kind,author_kind,body,ack_required,created_at,thread_root_id)
      VALUES ('01990000-0000-7000-8000-000000000002','reply','operator','b',0,'a',998);
      INSERT INTO board_message(record_id,kind,author_kind,audience,title,body,ack_required,expires_at,created_at,accepted_reply_id,accepted_by,accepted_at,claim_id)
      VALUES ('01990000-0000-7000-8000-000000000006','question','operator','operator','t','b',0,'z','a',997,'operator','a',996);
      INSERT INTO board_message_tag(message_id,kind,value,origin,record_id) VALUES (995,'task','T-1','sender','01990000-0000-7000-8000-000000000003');
      INSERT INTO board_receipt(message_id,reader_session,audience_at_posting,record_id) VALUES (994,'operator',1,'01990000-0000-7000-8000-000000000004');
      INSERT INTO board_reach_delivery(message_source,message_id,reader_session,reader_project,delivery_point,blocked_stop,audience,acknowledgement_required,posted_at,session_started_at,posting_timing,concern,recorded_at,record_id)
      VALUES ('local','993','operator','p','stop',0,'operator',0,'a','a','after-session','concerned','a','01990000-0000-7000-8000-000000000005');
    `)
    expect(() => applyMigrations(database)).toThrow(
      'board_claim.superseded_by_claim_record_id=1, board_message.thread_root_record_id=1, board_message.accepted_reply_record_id=1, board_message.claim_record_id=1, board_message_tag.message_record_id=1, board_receipt.message_record_id=1, board_reach_delivery.message_record_id=1',
    )
    expect(
      database.query("SELECT name FROM pragma_table_info('board_message')").all(),
    ).toContainEqual({ name: 'id' })
    expect(count(database, 'board_message_tag')).toBe(1)
  } finally {
    database.close()
  }
})

test('every declared board foreign key leads an index', () => {
  const database = new Database(':memory:')
  try {
    applyMigrations(database)
    for (const table of TABLES) {
      const leading = new Set(
        database
          .query<{ name: string }, []>(`SELECT name FROM pragma_index_list('${table}')`)
          .all()
          .flatMap(({ name }) =>
            database
              .query<{ name: string }, []>(
                `SELECT name FROM pragma_index_info('${name}') WHERE seqno=0`,
              )
              .all()
              .map((row) => row.name),
          ),
      )
      for (const foreignKey of database
        .query<{ from: string }, []>(`SELECT "from" FROM pragma_foreign_key_list('${table}')`)
        .all())
        expect(leading.has(foreignKey.from), `${table}.${foreignKey.from}`).toBeTrue()
    }
  } finally {
    database.close()
  }
})
