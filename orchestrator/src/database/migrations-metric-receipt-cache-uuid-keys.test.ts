import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { applyMigrations } from './migrations.ts'
import { migrationBoundaryTestDatabase } from './test-database.fixture.ts'

const MIGRATION = '0161_metric_receipt_cache_uuid_keys'

function column(database: Database, table: string, name: string) {
  return database
    .query<{ name: string; notnull: number; pk: number }, []>(
      `SELECT name,"notnull",pk FROM pragma_table_info('${table}') WHERE name='${name}'`,
    )
    .get()
}

test('keys metrics and receipt cache rows by UUID without losing their values', () => {
  const database = migrationBoundaryTestDatabase(MIGRATION)
  try {
    database.exec(`
      DELETE FROM metric;
      INSERT INTO metric(
        record_id,day,claude_tokens,cache_read,messages,tasks,collected_at,canon_tokens,
        other_tokens,commits,files,lines_product,lines_test,lines_docs,lines_config,lines_generated
      ) VALUES
        ('01990000-0000-7000-8000-000000001801','2026-10-24',11,12,13,14,'kept-at',
         15,16,17,18,19,20,21,22,23),
        ('01990000-0000-7000-8000-000000001802','2026-10-25',31,32,33,34,'later-at',
         35,36,37,38,39,40,41,42,43);
      INSERT INTO hosted_board_message_cache(id,kind,revision,payload)
      VALUES ('message-a','notice','1','{}');
      INSERT INTO hosted_board_receipt_cache(
        message_id,reader_session,audience_at_posting,delivered_at,acknowledged_at,
        pending_sync,sync_error,successor
      ) VALUES ('message-a','reader-a',1,'delivered-at','acknowledged-at',1,'kept-error',1);
    `)

    expect(applyMigrations(database)).toContain(MIGRATION)
    expect(column(database, 'metric', 'record_id')).toEqual({
      name: 'record_id',
      notnull: 1,
      pk: 1,
    })
    expect(column(database, 'hosted_board_receipt_cache', 'record_id')).toEqual({
      name: 'record_id',
      notnull: 1,
      pk: 1,
    })
    expect(database.query('SELECT * FROM metric ORDER BY day').all()).toEqual([
      {
        record_id: '01990000-0000-7000-8000-000000001801',
        day: '2026-10-24',
        claude_tokens: 11,
        cache_read: 12,
        messages: 13,
        tasks: 14,
        collected_at: 'kept-at',
        canon_tokens: 15,
        other_tokens: 16,
        commits: 17,
        files: 18,
        lines_product: 19,
        lines_test: 20,
        lines_docs: 21,
        lines_config: 22,
        lines_generated: 23,
      },
      {
        record_id: '01990000-0000-7000-8000-000000001802',
        day: '2026-10-25',
        claude_tokens: 31,
        cache_read: 32,
        messages: 33,
        tasks: 34,
        collected_at: 'later-at',
        canon_tokens: 35,
        other_tokens: 36,
        commits: 37,
        files: 38,
        lines_product: 39,
        lines_test: 40,
        lines_docs: 41,
        lines_config: 42,
        lines_generated: 43,
      },
    ])
    const receipt = database.query('SELECT * FROM hosted_board_receipt_cache').get() as Record<
      string,
      unknown
    >
    expect(receipt).toMatchObject({
      message_id: 'message-a',
      reader_session: 'reader-a',
      audience_at_posting: 1,
      delivered_at: 'delivered-at',
      acknowledged_at: 'acknowledged-at',
      pending_sync: 1,
      sync_error: 'kept-error',
      successor: 1,
    })
    expect(() =>
      database.exec(`INSERT INTO metric(
        record_id,day,claude_tokens,cache_read,messages,tasks,collected_at
      ) VALUES ('01990000-0000-7000-8000-000000001803','2026-10-24',1,1,1,1,'at')`),
    ).toThrow('UNIQUE constraint failed: metric.day')
    expect(() =>
      database.exec(`INSERT INTO hosted_board_receipt_cache(
        record_id,message_id,reader_session,audience_at_posting
      ) VALUES ('01990000-0000-7000-8000-000000001804','message-a','reader-a',0)`),
    ).toThrow()
  } finally {
    database.close()
  }
})

test('refuses duplicate metric record ids and names every affected day', () => {
  const database = migrationBoundaryTestDatabase(MIGRATION)
  try {
    database.exec(`
      DROP INDEX metric_record_id_unique;
      DELETE FROM metric;
      INSERT INTO metric(record_id,day,claude_tokens,cache_read,messages,tasks,collected_at)
      VALUES
        ('duplicate-id','2026-10-24',1,1,1,1,'at'),
        ('duplicate-id','2026-10-25',1,1,1,1,'at');
    `)
    expect(() => applyMigrations(database)).toThrow(
      'metric.day is NULL or empty, or metric.record_id is NULL, empty, or duplicate for days [2026-10-24,2026-10-25]',
    )
    expect(column(database, 'metric', 'day')).toEqual({ name: 'day', notnull: 0, pk: 1 })
    expect(
      database.query('SELECT COUNT(*) count FROM orch_migrations WHERE version=?').get(MIGRATION),
    ).toEqual({ count: 0 })
  } finally {
    database.close()
  }
})

test('refuses a NULL metric day with the migration remedy', () => {
  const database = migrationBoundaryTestDatabase(MIGRATION)
  try {
    database.exec(`
      DELETE FROM metric;
      INSERT INTO metric(record_id,day,claude_tokens,cache_read,messages,tasks,collected_at)
      VALUES ('01990000-0000-7000-8000-000000001805',NULL,1,1,1,1,'at');
    `)
    expect(() => applyMigrations(database)).toThrow(
      'metric.day is NULL or empty, or metric.record_id is NULL, empty, or duplicate for days [<NULL>]\n' +
        `cleared by: repair the named metric identities, then run \`${PLATFORM_SLUG} machine migrate\``,
    )
    expect(column(database, 'metric', 'day')).toEqual({ name: 'day', notnull: 0, pk: 1 })
    expect(database.query('SELECT record_id,day FROM metric').get()).toEqual({
      record_id: '01990000-0000-7000-8000-000000001805',
      day: null,
    })
  } finally {
    database.close()
  }
})
