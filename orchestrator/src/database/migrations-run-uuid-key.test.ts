import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { PLATFORM_NAME } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { nextRunNumber } from '../run/run-number.ts'
import { applyMigrations, applyMigrationsBefore } from './migrations.ts'
import {
  fixtureProjectRecordId,
  migrationBoundaryTestDatabase,
} from './test-database.fixture.ts'

migrationBoundaryTestDatabase('0124_run_uuid_key').close()
migrationBoundaryTestDatabase('0125_question_uuid_key').close()

const CHILD_REFERENCES = [
  ['blocker', 'run_id', 'run_record_id'],
  ['board_claim', 'run_id', 'run_record_id'],
  ['board_message', 'author_run_id', 'author_run_record_id'],
  ['calibration', 'run_id', 'run_record_id'],
  ['canon_eval', 'run_id', 'run_record_id'],
  ['compared_pair', 'run_a_id', 'run_a_record_id'],
  ['compared_pair', 'run_b_id', 'run_b_record_id'],
  ['contention', 'run_id', 'run_record_id'],
  ['duel', 'winner_run_id', 'winner_run_record_id'],
  ['duel', 'loser_run_id', 'loser_run_record_id'],
  ['gate_execution', 'run_id', 'run_record_id'],
  ['question', 'run_id', 'run_record_id'],
  ['question_delivery', 'run_id', 'run_record_id'],
  ['resource_claim', 'root_run_id', 'root_run_record_id'],
  ['resource_claim', 'run_id', 'run_record_id'],
  ['review_lens', 'run_id', 'run_record_id'],
  ['run_carried_ruling', 'run_id', 'run_record_id'],
  ['run_checkpoint', 'run_id', 'run_record_id'],
  ['run_message', 'root_run_id', 'root_run_record_id'],
  ['run_message', 'run_id', 'run_record_id'],
  ['run_mutation_audit', 'run_id', 'run_record_id'],
  ['run_mutation_audit', 'root_id', 'root_run_record_id'],
  ['run_mutation_audit', 'turn_id', 'turn_run_record_id'],
  ['score', 'run_id', 'run_record_id'],
  ['worker_note_request', 'run_id', 'run_record_id'],
] as const

const RENAMED_RUN_COLUMNS = new Map<string, string>([
  ['id', 'number'],
  ['retry_of', 'retry_of_record_id'],
  ['parent_run_id', 'parent_run_record_id'],
  ...CHILD_REFERENCES.map(([, oldColumn, newColumn]) => [oldColumn, newColumn] as const),
])

const REBUILT_TABLES = [
  'run',
  ...new Set(CHILD_REFERENCES.map(([table]) => table)),
  'check_execution',
  'question_mutation_audit',
  'review_finding',
  'board_message_tag',
  'board_receipt',
] as const

type ColumnDefinition = {
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
}

type ForeignKeyDefinition = {
  table: string
  from: string
  to: string
  on_update: string
  on_delete: string
  match: string
}

function columns(database: Database, table: string): ColumnDefinition[] {
  return (database.query(`PRAGMA table_info(${table})`).all() as ColumnDefinition[])
    .map(({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull, dflt_value, pk }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function expectedColumns(table: string, before: ColumnDefinition[]): ColumnDefinition[] {
  return before
    .map((column) => {
      if (table === 'run' && column.name === 'record_id') return { ...column, pk: 1 }
      const renamed = RENAMED_RUN_COLUMNS.get(column.name)
      if (!renamed || (column.name === 'id' && table !== 'run')) return column
      return {
        ...column,
        name: renamed,
        type: renamed === 'number' ? 'INTEGER' : 'TEXT',
        notnull: renamed === 'number' ? 1 : column.notnull,
        pk: table === 'run' && column.name === 'id' ? 0 : column.pk,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

function foreignKeys(database: Database, table: string): ForeignKeyDefinition[] {
  return (
    database.query(`PRAGMA foreign_key_list(${table})`).all() as Array<
      ForeignKeyDefinition & { id: number; seq: number }
    >
  )
    .map(({ table: parent, from, to, on_update, on_delete, match }) => ({
      table: parent,
      from,
      to,
      on_update,
      on_delete,
      match,
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
}

function expectedForeignKeys(
  table: string,
  before: ForeignKeyDefinition[],
): ForeignKeyDefinition[] {
  const expected = before.map((foreignKey) =>
    foreignKey.table === 'run'
      ? {
          ...foreignKey,
          from: RENAMED_RUN_COLUMNS.get(foreignKey.from) ?? foreignKey.from,
          to: 'record_id',
        }
      : foreignKey,
  )
  if (table === 'run') {
    expected.push({
      table: 'run',
      from: 'retry_of_record_id',
      to: 'record_id',
      on_update: 'NO ACTION',
      on_delete: 'NO ACTION',
      match: 'NONE',
    })
  }
  if (table === 'contention') {
    expected.push({
      table: 'run',
      from: 'run_record_id',
      to: 'record_id',
      on_update: 'NO ACTION',
      on_delete: 'NO ACTION',
      match: 'NONE',
    })
  }
  return expected.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
}

function schemaObjects(
  database: Database,
  types: string[],
): Array<{ type: string; name: string; sql: string }> {
  const placeholders = types.map(() => '?').join(',')
  return (
    database
      .query(
        `SELECT type,name,sql FROM sqlite_schema WHERE type IN (${placeholders}) AND sql IS NOT NULL`,
      )
      .all(...types) as Array<{ type: string; name: string; sql: string }>
  )
    .map(({ type, name, sql }) => ({
      type,
      name,
      sql: sql.replaceAll(/\s+/g, ' ').replaceAll(/,\s+/g, ',').trim(),
    }))
    .sort((a, b) => `${a.type}:${a.name}`.localeCompare(`${b.type}:${b.name}`))
}

function insertRun(database: Database, parentRunId: number | null = null): number {
  return (
    database
      .query(
        `INSERT INTO run
         (record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,parent_run_id)
         VALUES (?,'2026-10-18','codex','implement','sha',1,'prompt','ok',?) RETURNING id`,
      )
      .get(newRecordId(), parentRunId) as { id: number }
  ).id
}

function seedEveryRunRelationship(database: Database): { root: number; turn: number } {
  const root = insertRun(database)
  const turn = insertRun(database, root)
  database.query('UPDATE run SET retry_of=? WHERE id=?').run(root, turn)
  database
    .query(
      `INSERT INTO blocker (record_id,run_id,at,what,source)
       VALUES (?,?, '2026-10-18','blocked','declared')`,
    )
    .run(newRecordId(), root)
  database
    .query(
      `INSERT INTO calibration (record_id,run_id,delivery,quality,at)
       VALUES (?,?,'full','right','2026-10-18')`,
    )
    .run(newRecordId(), root)
  database
    .query(
      `INSERT INTO canon_eval (record_id,slug,run_id,canon_sha,agent,pass,why,at)
       VALUES (?,'canon',?,'sha','codex',1,'right','2026-10-18')`,
    )
    .run(newRecordId(), root)
  database
    .query('INSERT INTO compared_pair VALUES (?,?,?,?)')
    .run(root, turn, '2026-10-18', newRecordId())
  database
    .query(
      `INSERT INTO contention
       (record_id,at,resource_kind,resource_key,event_kind,run_id)
       VALUES (?,'2026-10-18','store','orch','wait',?)`,
    )
    .run(newRecordId(), root)
  database
    .query(
      `INSERT INTO duel (record_id,job,winner_run_id,loser_run_id,at)
       VALUES (?,'implement',?,?,'2026-10-18')`,
    )
    .run(newRecordId(), root, turn)
  const gateExecution = (
    database
      .query(
        "INSERT INTO gate_execution (record_id,run_id,requested_at) VALUES (?,?,'2026-10-18') RETURNING id",
      )
      .get(newRecordId(), root) as { id: number }
  ).id
  database
    .query(
      `INSERT INTO check_execution
       (record_id,gate_execution_id,check_name,category,wall_ms,exit_code)
       VALUES (?,?,'types','static',1,0)`,
    )
    .run(newRecordId(), gateExecution)
  const question = (
    database
      .query(
        `INSERT INTO question (record_id,run_id,asked_at,question)
         VALUES (?,?,'2026-10-18','Which?') RETURNING id`,
      )
      .get(newRecordId(), root) as { id: number }
  ).id
  database
    .query(
      `INSERT INTO question_delivery (record_id,question_id,run_id,mode,outcome,at)
       VALUES (?,?,?,'live','delivered','2026-10-18')`,
    )
    .run(newRecordId(), question, turn)
  database
    .query(
      `INSERT INTO question_mutation_audit (record_id,question_id,action,at)
       VALUES (?,?,'rule','2026-10-18')`,
    )
    .run(newRecordId(), question)
  database
    .query(
      `INSERT INTO resource_claim
       (record_id,root_run_id,run_id,kind,allocation_key,state,claimed_at)
       VALUES (?,?,?,'worktree','tree','claimed','2026-10-18')`,
    )
    .run(newRecordId(), root, turn)
  const review = (
    database
      .query("INSERT INTO review (record_id,recorded_at) VALUES (?,'2026-10-18') RETURNING id")
      .get(newRecordId()) as { id: number }
  ).id
  const reviewLens = (
    database
      .query(
        `INSERT INTO review_lens
       (record_id,review_id,run_id,lens,agent,standards_read,files_covered,commands_run,could_not_verify)
       VALUES (?,?,?,'correctness','codex','[]','[]','[]','[]') RETURNING id`,
      )
      .get(newRecordId(), review, root) as { id: number }
  ).id
  database
    .query(
      `INSERT INTO review_finding
       (record_id,review_id,review_lens_id,ordinal,severity,location,evidence,proposed_correction)
       VALUES (?,?,?,1,'high','file:1','evidence','fix')`,
    )
    .run(newRecordId(), review, reviewLens)
  database.query('INSERT INTO run_carried_ruling VALUES (?,?,?)').run(turn, question, newRecordId())
  database
    .query(
      `INSERT INTO run_checkpoint
       (record_id,run_id,checkpoint_no,commit_sha,created_at) VALUES (?,?,1,'abc','2026-10-18')`,
    )
    .run(newRecordId(), root)
  database
    .query(
      `INSERT INTO run_message
       (record_id,direction,root_run_id,run_id,body,created_at,delivery)
       VALUES (?,'to_worker',?,?,'message','2026-10-18','architect_cli')`,
    )
    .run(newRecordId(), root, turn)
  database
    .query(
      `INSERT INTO run_mutation_audit
       (record_id,run_id,root_id,turn_id,action,at) VALUES (?,?,?,?,'continue','2026-10-18')`,
    )
    .run(newRecordId(), turn, root, turn)
  database
    .query(
      `INSERT INTO score (record_id,run_id,delivery,quality,scored_at)
       VALUES (?,?,'full','right','2026-10-18')`,
    )
    .run(newRecordId(), root)
  database
    .query(
      `INSERT INTO worker_note_request
       (record_id,run_id,text,requested_at,status) VALUES (?,?,'note','2026-10-18','requested')`,
    )
    .run(newRecordId(), root)
  const claim = (
    database
      .query(
        `INSERT INTO board_claim
         (record_id,project,subject_kind,subject_value,holder_kind,run_id,duration_ms,taken_at,renewed_at,lapses_at)
         VALUES (?,?,'resource','tree','operator',?,100,'2026-10-18','2026-10-18','2026-10-19') RETURNING id`,
      )
      .get(newRecordId(), PLATFORM_NAME, root) as { id: number }
  ).id
  const message = (
    database
      .query(
        `INSERT INTO board_message
       (record_id,kind,author_kind,author_run_id,audience,title,body,ack_required,expires_at,created_at,claim_id)
       VALUES (?,'notice','worker',?,'operator','Title','Body',0,'2026-10-19','2026-10-18',?) RETURNING id`,
      )
      .get(newRecordId(), turn, claim) as { id: number }
  ).id
  database
    .query("INSERT INTO board_message_tag VALUES (?,'topic','uuid','sender',?)")
    .run(message, newRecordId())
  database
    .query(
      'INSERT INTO board_receipt (message_id,reader_session,audience_at_posting,record_id) VALUES (?,?,1,?)',
    )
    .run(message, 'architect', newRecordId())
  return { root, turn }
}

test('run UUID-key migration changes only run identity in rebuilt schema objects', () => {
  const before = migrationBoundaryTestDatabase('0124_run_uuid_key')
  const after = migrationBoundaryTestDatabase('0125_question_uuid_key')
  try {
    for (const table of REBUILT_TABLES) {
      expect(columns(after, table), `${table} columns`).toEqual(
        expectedColumns(table, columns(before, table)),
      )
      expect(foreignKeys(after, table), `${table} foreign keys`).toEqual(
        expectedForeignKeys(table, foreignKeys(before, table)),
      )
    }
    expect(schemaObjects(after, ['trigger', 'view'])).toEqual(
      schemaObjects(before, ['trigger', 'view']),
    )

    const dependentTables = [
      'check_execution',
      'question_mutation_audit',
      'review_finding',
      'board_message_tag',
      'board_receipt',
    ]
    for (const table of dependentTables) {
      const beforeIndexes = schemaObjects(before, ['index']).filter((object) =>
        object.sql.includes(` ON ${table}(`),
      )
      const afterIndexes = schemaObjects(after, ['index']).filter((object) =>
        object.sql.includes(` ON ${table}(`),
      )
      expect(afterIndexes, `${table} indexes`).toEqual(beforeIndexes)
    }
  } finally {
    before.close()
    after.close()
  }
})

test('run UUID-key migration preserves every run relationship and display number', () => {
  const database = migrationBoundaryTestDatabase('0124_run_uuid_key')
  try {
    const { root, turn } = seedEveryRunRelationship(database)
    const before = new Map(
      CHILD_REFERENCES.map(([table, oldColumn]) => [
        `${table}.${oldColumn}`,
        (
          database
            .query(`SELECT COUNT(*) n FROM ${table} WHERE ${oldColumn} IS NOT NULL`)
            .get() as {
            n: number
          }
        ).n,
      ]),
    )

    expect(applyMigrationsBefore(database, '0125_question_uuid_key')).toEqual(['0124_run_uuid_key'])
    expect(database.query('SELECT number FROM run ORDER BY number').all()).toEqual([
      { number: root },
      { number: turn },
    ])
    for (const [table, oldColumn, newColumn] of CHILD_REFERENCES) {
      const joined = (
        database
          .query(
            `SELECT COUNT(*) n FROM ${table} child JOIN run parent ON parent.record_id=child.${newColumn}`,
          )
          .get() as { n: number }
      ).n
      expect(joined).toBe(before.get(`${table}.${oldColumn}`)!)
    }
    expect(database.query('PRAGMA foreign_key_check').all()).toEqual([])

    database.query('DELETE FROM gate_execution').run()
    expect(database.query('SELECT COUNT(*) n FROM check_execution').get()).toEqual({ n: 0 })
    database.query('DELETE FROM review_lens').run()
    expect(database.query('SELECT COUNT(*) n FROM review_finding').get()).toEqual({ n: 0 })
    database.query('DELETE FROM board_message').run()
    expect(database.query('SELECT COUNT(*) n FROM board_message_tag').get()).toEqual({ n: 0 })
    expect(database.query('SELECT COUNT(*) n FROM board_receipt').get()).toEqual({ n: 0 })
    database.query('DELETE FROM question').run()
    expect(database.query('SELECT COUNT(*) n FROM question_mutation_audit').get()).toEqual({ n: 0 })
    expect(database.query('SELECT COUNT(*) n FROM run_carried_ruling').get()).toEqual({ n: 0 })
  } finally {
    database.close()
  }
})

test('run UUID-key migration reorders compared pairs by UUID without losing the pair', () => {
  const database = migrationBoundaryTestDatabase('0124_run_uuid_key')
  try {
    database.exec(`
      INSERT INTO run (record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
      VALUES ('zzzz','2026-10-18','codex','implement','sha',1,'prompt','ok');
      INSERT INTO run (record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
      VALUES ('aaaa','2026-10-18','codex','implement','sha',1,'prompt','ok');
      INSERT INTO compared_pair (run_a_id,run_b_id,compared_at,record_id)
      SELECT MIN(id),MAX(id),'2026-10-18','pair-record' FROM run WHERE record_id IN ('zzzz','aaaa');
    `)

    expect(applyMigrationsBefore(database, '0125_question_uuid_key')).toEqual(['0124_run_uuid_key'])
    expect(database.query('SELECT * FROM compared_pair').all()).toEqual([
      {
        run_a_record_id: 'aaaa',
        run_b_record_id: 'zzzz',
        compared_at: '2026-10-18',
        record_id: 'pair-record',
      },
    ])
  } finally {
    database.close()
  }
})

test('run UUID-key migration refuses an unmapped child with its count', () => {
  const database = migrationBoundaryTestDatabase('0124_run_uuid_key')
  try {
    database
      .query(
        `INSERT INTO contention
         (record_id,at,resource_kind,resource_key,event_kind,run_id)
         VALUES (?,'2026-10-18','store','orch','wait',999999)`,
      )
      .run(newRecordId())
    expect(() => applyMigrationsBefore(database, '0125_question_uuid_key')).toThrow(
      'contention.run_id=1',
    )
  } finally {
    database.close()
  }
})

test('run number allocation starts after every previously issued number and never reuses a deleted reservation', () => {
  const database = migrationBoundaryTestDatabase('0124_run_uuid_key')
  try {
    insertRun(database)
    database.query("UPDATE sqlite_sequence SET seq=50 WHERE name='run'").run()
    const applied = applyMigrations(database)
    expect(applied[0]).toBe('0124_run_uuid_key')
    expect(applied.slice(1)).toContain('0125_question_uuid_key')
    expect(
      database.query("SELECT last_number FROM entity_number_counter WHERE entity='run'").get(),
    ).toEqual({ last_number: 50 })

    const reservedId = newRecordId()
    database
      .query(
        `INSERT INTO run(record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,project_record_id)
         VALUES (?,?, '2026-10-18','(pending)','implement','sha',1,'prompt','running',?)`,
      )
      .run(reservedId, nextRunNumber(database), fixtureProjectRecordId(database))
    expect(database.query('SELECT number FROM run WHERE record_id=?').get(reservedId)).toEqual({
      number: 51,
    })
    database.query('DELETE FROM run WHERE record_id=?').run(reservedId)

    const nextId = newRecordId()
    database
      .query(
        `INSERT INTO run(record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,project_record_id)
         VALUES (?,?, '2026-10-18','codex','implement','sha',1,'prompt','running',?)`,
      )
      .run(nextId, nextRunNumber(database), fixtureProjectRecordId(database))
    expect(database.query('SELECT number FROM run WHERE record_id=?').get(nextId)).toEqual({
      number: 52,
    })
  } finally {
    database.close()
  }
})
