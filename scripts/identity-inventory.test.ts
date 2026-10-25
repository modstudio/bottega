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
  syncedSourceRefusals,
} from './identity-inventory.ts'
import { KEY_MANIFESTS } from './identity-key-manifest.ts'

const EMPTY: KeyManifests = {
  values: [],
  references: [],
  externalIdentifiers: [],
  uuids: [],
  infrastructure: [],
  syncedSources: {},
}
const column = (
  table: string,
  name: string,
  type: string,
  primaryKey = false,
  foreignKey = false,
) => ({ table, name, type, required: true, primaryKey, foreignKey, foreignTable: null })

const write = (sources: readonly string[]) => ({
  store: 'hub' as const,
  kind: 'write' as const,
  sources,
  reason: sources.length ? 'rows from local tables' : 'no local table',
})
const schemas = [
  { store: 'hub' as const, table: 'task', foreignTables: [] },
  { store: 'hub' as const, table: 'child', foreignTables: ['install_binding'] },
]
const infrastructure = [
  { store: 'hub' as const, table: 'install_binding', reason: 'machine binding' },
]

test('a synced method without a declaration is refused with its remedy', () => {
  expect(syncedSourceRefusals({}, ['hub.taskClient.push'], infrastructure, schemas)).toEqual([
    'hub.taskClient.push: synced source declaration is missing; remedy: declare it with its source tables',
  ])
})

test('a synced source may not be machine-local infrastructure', () => {
  expect(
    syncedSourceRefusals(
      { 'hub.taskClient.push': write(['install_binding']) },
      ['hub.taskClient.push'],
      infrastructure,
      schemas,
    ),
  ).toContain(
    'hub.taskClient.push: synced source hub.install_binding is machine-local infrastructure; remedy: give the table a UUID primary key, or stop syncing it',
  )
})

test('a synced source must exist in its migrated store schema', () => {
  expect(
    syncedSourceRefusals(
      { 'hub.taskClient.push': write(['missing']) },
      ['hub.taskClient.push'],
      infrastructure,
      schemas,
    ),
  ).toEqual([
    'hub.taskClient.push: synced source hub.missing does not exist in the migrated schema; remedy: declare an existing source table',
  ])
})

test('a synced source may not reference machine-local infrastructure', () => {
  expect(
    syncedSourceRefusals(
      { 'hub.taskClient.push': write(['child']) },
      ['hub.taskClient.push'],
      infrastructure,
      schemas,
    ),
  ).toEqual([
    'hub.taskClient.push: synced source hub.child has a foreign key into machine-local infrastructure install_binding; remedy: give the table a UUID primary key, or stop syncing it',
  ])
})

test('complete consistent synced source declarations pass', () => {
  expect(
    syncedSourceRefusals(
      {
        'hub.taskClient.list': {
          store: 'hub',
          kind: 'read',
          sources: [],
          reason: 'read',
        },
        'hub.taskClient.push': write(['task']),
      },
      ['hub.taskClient.list', 'hub.taskClient.push'],
      infrastructure,
      schemas,
    ),
  ).toEqual([])
})

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
  const manifests = {
    ...EMPTY,
    references: [{ store: 'hosted' as const, column: 'child.parent_id', reason: 'parent row' }],
  }
  const table = {
    name: 'child',
    primaryKey: ['record_id'],
    columns: [column('child', 'record_id', 'uuid', true), column('child', 'parent_id', 'integer')],
  }
  expect(classifyKeyInventory('hosted', [table], manifests).findings).toContain(
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

test('an external identifier cannot conceal a primary or foreign key', () => {
  for (const [name, primaryKey, foreignKey] of [
    ['primary', true, false],
    ['foreign', false, true],
  ] as const) {
    const table = {
      name,
      primaryKey: primaryKey ? ['session_id'] : ['record_id'],
      columns: [
        column(name, 'record_id', 'uuid', !primaryKey),
        column(name, 'session_id', 'text', primaryKey, foreignKey),
      ],
    }
    const manifests = {
      ...EMPTY,
      externalIdentifiers: [
        { store: 'hosted' as const, column: `${name}.session_id`, reason: 'harness session id' },
      ],
    }
    expect(classifyKeyInventory('hosted', [table], manifests).findings).toContain(
      primaryKey ? `${name}:primary-key` : `${name}.session_id:reference`,
    )
  }
})

test('a baseline entry that disappeared must be removed', () => {
  expect(() => assertShrinkingKeyBaseline('hosted', [], ['old:primary-key'], [])).toThrow(
    'baseline entries disappeared; remove them: old:primary-key',
  )
})

test('a candidate baseline may not grow after initialization', () => {
  expect(() =>
    assertShrinkingKeyBaseline('hosted', ['new:primary-key'], ['new:primary-key'], []),
  ).toThrow('identity baseline may only shrink; candidate added: new:primary-key')
})

test('a missing base baseline accepts the initial candidate', () => {
  expect(() =>
    assertShrinkingKeyBaseline('hosted', ['initial:primary-key'], ['initial:primary-key'], null),
  ).not.toThrow()
})

test('an unclassified reference-shaped column is refused', () => {
  const table = {
    name: 'child',
    primaryKey: ['record_id'],
    columns: [column('child', 'record_id', 'uuid', true), column('child', 'run_ref', 'text')],
  }
  expect(() => classifyKeyInventory('hosted', [table], EMPTY)).toThrow(
    'reference-shaped column child.run_ref is not classified',
  )
})

test('an unclassified project-name-shaped orchestrator column is refused', () => {
  const table = {
    name: 'cursor',
    primaryKey: ['record_id'],
    columns: [column('cursor', 'record_id', 'uuid', true), column('cursor', 'repo', 'text')],
  }
  expect(() => classifyKeyInventory('orchestrator', [table], EMPTY)).toThrow(
    'orchestrator reference-shaped column cursor.repo is not classified',
  )
})

test('real natural and undeclared references remain measured', () => {
  const database = new Database(':memory:')
  try {
    applyMigrations(database)
    const inventory = classifyKeyInventory(
      'orchestrator',
      readSqliteKeyTables(database),
      KEY_MANIFESTS,
    )
    expect(inventory.findings).toContain('port_ref.task_key:reference')
  } finally {
    database.close()
  }
})

test('real board reader run labels remain measured as row references', () => {
  const database = new Database(':memory:')
  try {
    applyMigrations(database)
    database.run('PRAGMA foreign_keys=OFF')
    database
      .query(
        `INSERT INTO hosted_board_receipt_cache
         (message_id,reader_session,audience_at_posting,pending_sync)
         VALUES ('01990000-0000-7000-8000-000000001214','run:42',0,0)`,
      )
      .run()
    expect(database.query('SELECT reader_session FROM hosted_board_receipt_cache').get()).toEqual({
      reader_session: 'run:42',
    })
    expect(
      classifyKeyInventory('orchestrator', readSqliteKeyTables(database), KEY_MANIFESTS).findings,
    ).toContain('hosted_board_receipt_cache.reader_session:reference')
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
