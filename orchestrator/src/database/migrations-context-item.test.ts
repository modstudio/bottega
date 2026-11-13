import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  CONTEXT_HOLDER_KINDS,
  CONTEXT_ITEM_KINDS,
} from '../../../shared/context-item-vocabulary.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { applyMigrations } from './migrations.ts'
import { migrationBoundaryTestDatabase } from './test-database.fixture.ts'

const MIGRATION = '0222_context_item'
const retiredKinds = [['next', 'action'].join('-'), ['open', 'question'].join('-')]
const kinds = [...CONTEXT_ITEM_KINDS, ...retiredKinds]
const FOUR_KINDS_MIGRATION = '0224_context_item_four_kinds'

function encoded(kind: string, source: string, body: string, objection?: string) {
  return [
    '---',
    `kind: ${JSON.stringify(kind)}`,
    `source: ${JSON.stringify(source)}`,
    ...(objection ? [`objection: ${JSON.stringify(objection)}`] : []),
    '---',
    body,
  ].join('\n')
}

function seed(database: Database, holder: string, kind: string) {
  const source = kind === 'ruling' ? 'q6165' : kind === 'position' ? 'q6056' : 'test'
  const body = kind === 'pointer' ? 'doc:01990000-0000-7000-8000-000000000001' : `${kind} body`
  database
    .query(
      `INSERT INTO doc(
        record_id,scope,subject,slug,title,body,delivery,created_at,updated_at,audiences
      ) VALUES (?,'context',?,?,?,?,?,'a','b','["technical"]')`,
    )
    .run(
      newRecordId(),
      holder,
      `${kind}-${holder.split(':')[0]}`,
      kind,
      encoded(kind, source, body, kind === 'ruling' ? 'the old choice' : undefined),
      'demand',
    )
}

test('context-item migration moves every kind, folds objections, and is idempotent', () => {
  const database = migrationBoundaryTestDatabase(MIGRATION)
  try {
    const holders = [`task:${newRecordId()}`, `session:${newRecordId()}`]
    for (const holder of holders) {
      for (const kind of kinds) seed(database, holder, kind)
    }

    expect(applyMigrations(database)).toContain(MIGRATION)
    const rows = database
      .query<
        {
          holder_kind: string
          holder_id: string
          kind: string
          body: string
          question_number: number | null
          target: string | null
        },
        []
      >(
        'SELECT holder_kind,holder_id,kind,body,question_number,target FROM context_item ORDER BY holder_kind,kind',
      )
      .all()
    expect(rows).toHaveLength(8)
    expect(new Set(rows.map((row) => `${row.holder_kind}:${row.holder_id}`))).toEqual(
      new Set(holders),
    )
    expect(rows.filter(({ kind }) => kind === 'ruling')).toEqual([
      expect.objectContaining({
        body: 'ruling body\n\nOverrode: the old choice',
        question_number: 6165,
      }),
      expect.objectContaining({
        body: 'ruling body\n\nOverrode: the old choice',
        question_number: 6165,
      }),
    ])
    expect(
      rows.filter(({ kind }) => kind === 'position').every((row) => row.question_number === 6056),
    ).toBe(true)
    expect(
      rows.filter(({ kind }) => kind === 'pointer').every((row) => row.target?.startsWith('doc:')),
    ).toBe(true)
    expect(
      database
        .query<{ count: number }, []>("SELECT COUNT(*) count FROM doc WHERE scope='context'")
        .get()!.count,
    ).toBe(0)
    expect(applyMigrations(database)).toEqual([])
    expect(
      database.query<{ count: number }, []>('SELECT COUNT(*) count FROM context_item').get()!.count,
    ).toBe(8)
  } finally {
    database.close()
  }
})

test('context-item migration CHECK vocabularies match the shared owner', () => {
  const sql = readFileSync(
    new URL('../../migrations/0224_context_item_four_kinds.sql', import.meta.url),
    'utf8',
  )
  const values = (column: string) => {
    const match = new RegExp(`(?:^|\\n) ${column} TEXT[^\\n]*${column} IN \\(([^)]+)\\)`).exec(sql)
    expect(match).not.toBeNull()
    return match![1]!.match(/'([^']+)'/g)?.map((value) => value.slice(1, -1)) ?? []
  }
  expect(values('holder_kind')).toEqual([...CONTEXT_HOLDER_KINDS])
  expect(values('kind')).toEqual([...CONTEXT_ITEM_KINDS])
})

test('context-item migration requires an exact q-number source', () => {
  const database = migrationBoundaryTestDatabase(MIGRATION)
  try {
    seed(database, `task:${newRecordId()}`, 'position')
    database.query("UPDATE doc SET body=replace(body, 'q6056', 'q6159:')").run()
    applyMigrations(database)
    expect(
      database
        .query<{ question_number: number | null }, []>(
          "SELECT question_number FROM context_item WHERE kind='position'",
        )
        .get()?.question_number,
    ).toBeNull()
  } finally {
    database.close()
  }
})

test('four-kind migration removes retired rows and tightens the CHECK', () => {
  const database = migrationBoundaryTestDatabase(FOUR_KINDS_MIGRATION)
  try {
    const holder = newRecordId()
    const insert = database.query(
      `INSERT INTO context_item
       (record_id,holder_kind,holder_id,slug,kind,body,source,created_at,updated_at)
       VALUES (?,'task',?,?,?,?,?,'2026-11-13','2026-11-13')`,
    )
    for (const kind of kinds) insert.run(newRecordId(), holder, kind, kind, `${kind} body`, 'test')

    expect(applyMigrations(database)).toContain(FOUR_KINDS_MIGRATION)
    expect(
      database
        .query<{ kind: string }, []>('SELECT kind FROM context_item ORDER BY kind')
        .all()
        .map(({ kind }) => kind),
    ).toEqual(['fact', 'pointer', 'position', 'ruling'])
    expect(() =>
      database
        .query(
          `INSERT INTO context_item
           (record_id,holder_kind,holder_id,slug,kind,body,source,created_at,updated_at)
           VALUES (?,'task',?,'retired',?,'body','test','2026-11-13','2026-11-13')`,
        )
        .run(newRecordId(), holder, 'next-action'),
    ).toThrow()
  } finally {
    database.close()
  }
})
