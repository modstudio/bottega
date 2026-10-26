import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { foreignKey, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { applyMigrations as applyHubMigrations } from '../hub/src/migrations.ts'
import * as taskClient from '../hub/src/task-client.ts'
import { applyMigrations } from '../orchestrator/src/database/migrations.ts'
import { enumerateClientMethods } from './identity-client-enumeration.ts'
import {
  assertShrinkingKeyBaseline,
  classifyKeyInventory,
  hostedKeyTablesFromModules,
  type KeyManifests,
  type KeyTable,
  readSqliteKeyTables,
  sqliteSyncedSchemaFacts,
  syncedSourceRefusals,
} from './identity-inventory.ts'
import { KEY_MANIFESTS } from './identity-key-manifest.ts'

const EMPTY: KeyManifests = {
  values: [],
  displayLabels: [],
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
) => ({
  table,
  name,
  type,
  required: true,
  primaryKey,
  foreignKey,
  foreignTargets: [],
})

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

test('a stale synced source declaration is refused with its remedy', () => {
  expect(
    syncedSourceRefusals(
      { 'hub.taskClient.removed': write(['task']) },
      [],
      infrastructure,
      schemas,
    ),
  ).toContain(
    'hub.taskClient.removed: synced source declaration is stale; remedy: remove the stale declaration',
  )
})

test('real client methods are enumerated with their prefix', () => {
  expect(enumerateClientMethods('hub.taskClient', taskClient)).toContain(
    'hub.taskClient.hostedPushChanges',
  )
})

test('a client prefix that enumerates no methods is refused', () => {
  expect(() => enumerateClientMethods('hub.emptyClient', {})).toThrow(
    'hub.emptyClient: client method enumeration yielded no methods',
  )
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
  const database = new Database(':memory:')
  try {
    applyHubMigrations(database, undefined, {
      machine_id: '01990000-0000-7000-8000-000000001214',
    })
    database.exec(`CREATE TABLE child (
      record_id TEXT PRIMARY KEY,
      binding_id INTEGER NOT NULL REFERENCES install_binding(id)
    )`)
    const facts = sqliteSyncedSchemaFacts('hub', readSqliteKeyTables(database))
    expect(
      readSqliteKeyTables(database)
        .find((table) => table.name === 'child')
        ?.columns.find((entry) => entry.name === 'binding_id')?.foreignTargets,
    ).toEqual([{ table: 'install_binding', column: 'id' }])
    expect(facts.find((fact) => fact.table === 'child')?.foreignTables).toEqual(['install_binding'])
    expect(
      syncedSourceRefusals(
        { 'hub.taskClient.push': write(['child']) },
        ['hub.taskClient.push'],
        infrastructure,
        facts,
      ),
    ).toEqual([
      'hub.taskClient.push: synced source hub.child has a foreign key into machine-local infrastructure install_binding; remedy: give the table a UUID primary key, or stop syncing it',
    ])
  } finally {
    database.close()
  }
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

test('a display label beside a UUID sibling produces no reference finding', () => {
  const table = {
    name: 'task',
    primaryKey: ['id'],
    columns: [
      column('task', 'id', 'uuid', true),
      column('task', 'task_key', 'text'),
      column('task', 'task_record_id', 'uuid'),
    ],
  }
  const manifests = {
    ...EMPTY,
    displayLabels: [
      {
        store: 'hosted' as const,
        column: 'task.task_key',
        sibling: 'task.task_record_id',
        reason: 'displayed task key',
      },
    ],
  }
  expect(classifyKeyInventory('hosted', [table], manifests).findings).not.toContain(
    'task.task_key:reference',
  )
})

test('a display label may name a foreign key to a UUID primary key as its sibling', () => {
  const parent = {
    name: 'project',
    primaryKey: ['id'],
    columns: [column('project', 'id', 'uuid', true)],
  }
  const sibling = {
    ...column('task', 'project_record_id', 'text', false, true),
    foreignTargets: [{ table: 'project', column: 'id' }],
  }
  const task = {
    name: 'task',
    primaryKey: ['id'],
    columns: [column('task', 'id', 'uuid', true), column('task', 'task_key', 'text'), sibling],
  }
  const manifests = {
    ...EMPTY,
    displayLabels: [
      {
        store: 'hosted' as const,
        column: 'task.task_key',
        sibling: 'task.project_record_id',
        reason: 'displayed task key',
      },
    ],
  }
  expect(classifyKeyInventory('hosted', [parent, task], manifests).findings).not.toContain(
    'task.task_key:reference',
  )
})

test('a display-label sibling must be on the same table', () => {
  const manifests = {
    ...EMPTY,
    displayLabels: [
      {
        store: 'hosted' as const,
        column: 'task.task_key',
        sibling: 'other.record_id',
        reason: 'displayed task key',
      },
    ],
  }
  const table = {
    name: 'task',
    primaryKey: ['id'],
    columns: [column('task', 'id', 'uuid', true), column('task', 'task_key', 'text')],
  }
  const other = {
    name: 'other',
    primaryKey: ['record_id'],
    columns: [column('other', 'record_id', 'uuid', true)],
  }
  expect(() => classifyKeyInventory('hosted', [table, other], manifests)).toThrow(
    'display label task.task_key sibling other.record_id is on another table; remedy: name a sibling on task',
  )
})

test('a display-label sibling must exist', () => {
  const manifests = {
    ...EMPTY,
    displayLabels: [
      {
        store: 'hosted' as const,
        column: 'task.task_key',
        sibling: 'task.record_id',
        reason: 'displayed task key',
      },
    ],
  }
  const table = {
    name: 'task',
    primaryKey: ['id'],
    columns: [column('task', 'id', 'uuid', true), column('task', 'task_key', 'text')],
  }
  expect(() => classifyKeyInventory('hosted', [table], manifests)).toThrow(
    'display label task.task_key sibling task.record_id does not exist; remedy: name an existing sibling column',
  )
})

test('a display-label sibling must be a UUID reference', () => {
  const manifests = {
    ...EMPTY,
    displayLabels: [
      {
        store: 'hosted' as const,
        column: 'task.task_key',
        sibling: 'task.task_record_id',
        reason: 'displayed task key',
      },
    ],
  }
  const table = {
    name: 'task',
    primaryKey: ['id'],
    columns: [
      column('task', 'id', 'uuid', true),
      column('task', 'task_key', 'text'),
      column('task', 'task_record_id', 'text'),
    ],
  }
  expect(() => classifyKeyInventory('hosted', [table], manifests)).toThrow(
    'display label task.task_key sibling task.task_record_id is not a UUID reference; remedy: name a UUID column or a foreign key to a UUID primary key',
  )
})

test('a display label may not overlap another identity manifest', () => {
  const table = {
    name: 'task',
    primaryKey: ['id'],
    columns: [
      column('task', 'id', 'uuid', true),
      column('task', 'task_key', 'text'),
      column('task', 'task_record_id', 'text'),
    ],
  }
  const displayLabels = [
    {
      store: 'hosted' as const,
      column: 'task.task_key',
      sibling: 'task.task_record_id',
      reason: 'displayed task key',
    },
  ]
  const taskRecordUuid = {
    store: 'hosted' as const,
    column: 'task.task_record_id',
    reason: 'task UUID',
  }
  for (const [manifest, overlapKind] of [
    ['values', 'value/display label'],
    ['references', 'display label/reference'],
    ['externalIdentifiers', 'display label/external identifier'],
    ['uuids', 'display label/UUID'],
  ] as const) {
    const overlap = { store: 'hosted' as const, column: 'task.task_key', reason: 'overlap' }
    const manifests = {
      ...EMPTY,
      displayLabels,
      uuids: manifest === 'uuids' ? [taskRecordUuid, overlap] : [taskRecordUuid],
      [manifest]: manifest === 'uuids' ? [taskRecordUuid, overlap] : [overlap],
    }
    expect(() => classifyKeyInventory('hosted', [table], manifests)).toThrow(
      `${overlapKind} manifests overlap: task.task_key`,
    )
  }
})

test('a display label needs a reason', () => {
  const table = {
    name: 'task',
    primaryKey: ['id'],
    columns: [
      column('task', 'id', 'uuid', true),
      column('task', 'task_key', 'text'),
      column('task', 'task_record_id', 'text'),
    ],
  }
  const manifests = {
    ...EMPTY,
    displayLabels: [
      {
        store: 'hosted' as const,
        column: 'task.task_key',
        sibling: 'task.task_record_id',
        reason: ' ',
      },
    ],
    uuids: [{ store: 'hosted' as const, column: 'task.task_record_id', reason: 'task UUID' }],
  }
  expect(() => classifyKeyInventory('hosted', [table], manifests)).toThrow(
    'display label task.task_key needs a reason; remedy: provide a non-empty reason',
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
    expect(inventory.findings).toContain('contention.resource_key:reference')
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
         (record_id,message_id,reader_session,audience_at_posting,pending_sync)
         VALUES ('01990000-0000-7000-8000-000000001213','01990000-0000-7000-8000-000000001214','run:42',0,0)`,
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

test('hosted discovery keeps every foreign-key target for a column', () => {
  const project = pgTable('project', {
    id: uuid().primaryKey(),
    spaceId: uuid('space_id').notNull(),
  })
  const task = pgTable(
    'task',
    {
      id: uuid().primaryKey(),
      projectId: uuid('project_id')
        .notNull()
        .references(() => project.id),
      spaceId: uuid('space_id').notNull(),
    },
    (table) => [
      foreignKey({
        columns: [table.projectId, table.spaceId],
        foreignColumns: [project.spaceId, project.id],
      }),
    ],
  )
  const tables = hostedKeyTablesFromModules([{ project, task }])
  expect(
    tables
      .find((table) => table.name === 'task')
      ?.columns.find((entry) => entry.name === 'project_id')?.foreignTargets,
  ).toEqual([
    { table: 'project', column: 'id' },
    { table: 'project', column: 'space_id' },
  ])
})
