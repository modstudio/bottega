import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { applyMigrations } from '../orchestrator/src/database/migrations.ts'
import {
  assertShrinkingKeyBaseline,
  classifyKeyInventory,
  hostedKeyTablesFromModules,
  type KeyManifests,
  type KeyTable,
  readSqliteKeyTables,
} from './identity-inventory.ts'
import { KEY_MANIFESTS } from './identity-key-manifest.ts'

const EMPTY: KeyManifests = { values: [], references: [], uuids: [], infrastructure: [] }
const column = (
  table: string,
  name: string,
  type: string,
  primaryKey = false,
  foreignKey = false,
) => ({ table, name, type, required: true, primaryKey, foreignKey })

test('every non-owned UUID primary-key shape is reported', () => {
  const cases: [string, KeyTable][] = [
    [
      'integer',
      { name: 'integer', primaryKey: ['id'], columns: [column('integer', 'id', 'integer', true)] },
    ],
    [
      'composite',
      {
        name: 'composite',
        primaryKey: ['left', 'right'],
        columns: [
          column('composite', 'left', 'text', true),
          column('composite', 'right', 'text', true),
        ],
      },
    ],
    ['missing', { name: 'missing', primaryKey: [], columns: [column('missing', 'name', 'text')] }],
    [
      'natural',
      { name: 'natural', primaryKey: ['slug'], columns: [column('natural', 'slug', 'text', true)] },
    ],
    [
      'referencing',
      {
        name: 'referencing',
        primaryKey: ['id'],
        columns: [column('referencing', 'id', 'uuid', true, true)],
      },
    ],
  ]
  for (const [name, table] of cases)
    expect(classifyKeyInventory('hosted', [table], EMPTY).findings).toContain(`${name}:primary-key`)
})

test('an undeclared parent integer is reported', () => {
  const table = {
    name: 'child',
    primaryKey: ['record_id'],
    columns: [column('child', 'record_id', 'uuid', true), column('child', 'parent_id', 'integer')],
  }
  expect(classifyKeyInventory('hosted', [table], EMPTY).findings).toContain(
    'child.parent_id:reference',
  )
})

test('a reviewed integer handle may not become a foreign key', () => {
  const manifests = {
    ...EMPTY,
    values: [{ store: 'hub' as const, column: 'note.number', reason: 'display handle' }],
  }
  const table = {
    name: 'note',
    primaryKey: ['record_id'],
    columns: [
      column('note', 'record_id', 'uuid', true),
      column('note', 'number', 'integer', false, true),
    ],
  }
  expect(() => classifyKeyInventory('hub', [table], manifests)).toThrow(
    'integer value note.number may not be a primary or foreign key',
  )
})

test('a baseline entry that disappeared must be removed', () => {
  expect(() => assertShrinkingKeyBaseline('hosted', [], ['old:primary-key'])).toThrow(
    'baseline entries disappeared; remove them: old:primary-key',
  )
})

test('real natural and undeclared references remain measured', () => {
  const database = new Database(':memory:')
  try {
    applyMigrations(database)
    database
      .query(
        `INSERT INTO lens
         (id,title,question,excludes,slots,version,enabled,requires_execution,record_id)
         VALUES ('architecture','Architecture','Question','[]','[]',1,1,0,
                 '01990000-0000-7000-8000-000000001214')`,
      )
      .run()
    expect(database.query("SELECT id FROM lens WHERE id='architecture'").get()).toEqual({
      id: 'architecture',
    })
    const inventory = classifyKeyInventory(
      'orchestrator',
      readSqliteKeyTables(database),
      KEY_MANIFESTS,
    )
    expect(inventory.findings).toContain('lens:primary-key')
    expect(inventory.findings).toContain('project_lens_profile.lens_id:reference')
    expect(inventory.findings).toContain('review_finding_amendment.finding_ordinal:reference')
    expect(inventory.findings).toContain('workflow_cursor.workflow_version:reference')
    expect(inventory.findings).toContain('workflow_cursor.catalogue_version:reference')
  } finally {
    database.close()
  }
})

test('hosted discovery inventories every pgTable export without naming it', () => {
  const otherwiseUnnamed = pgTable('otherwise_unnamed', { id: uuid().primaryKey(), label: text() })
  expect(hostedKeyTablesFromModules([{ otherwiseUnnamed }]).map((table) => table.name)).toEqual([
    'otherwise_unnamed',
  ])
})
