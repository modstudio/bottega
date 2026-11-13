import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { applyMigrations } from './migrations.ts'
import { migrationBoundaryTestDatabase } from './test-database.fixture.ts'

const MIGRATION = '0221_context_item'
const kinds = ['ruling', 'position', 'fact', 'pointer', 'next-action', 'open-question'] as const

function encoded(kind: (typeof kinds)[number], source: string, body: string, objection?: string) {
  return [
    '---',
    `kind: ${JSON.stringify(kind)}`,
    `source: ${JSON.stringify(source)}`,
    ...(objection ? [`objection: ${JSON.stringify(objection)}`] : []),
    '---',
    body,
  ].join('\n')
}

function seed(database: Database, holder: string, kind: (typeof kinds)[number]) {
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
    for (const holder of [`task:${newRecordId()}`, `session:${newRecordId()}`]) {
      for (const kind of kinds) seed(database, holder, kind)
    }

    expect(applyMigrations(database)).toContain(MIGRATION)
    const rows = database
      .query<
        { kind: string; body: string; question_number: number | null; target: string | null },
        []
      >('SELECT kind,body,question_number,target FROM context_item ORDER BY holder_kind,kind')
      .all()
    expect(rows).toHaveLength(12)
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
    ).toBe(12)
  } finally {
    database.close()
  }
})
