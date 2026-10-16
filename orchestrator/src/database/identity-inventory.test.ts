import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import {
  assertShrinkingKeyBaseline,
  classifyKeyInventory,
  decideIdentityInventory,
  EXEMPT_TABLES,
  IDENTITY_BASELINE,
  orchestratorIdentityInventory,
} from './identity-inventory.ts'
import { applyMigrations } from './migrations.ts'

test('migrated tables are converted, exempt with reasons, or in the shrinking baseline', () => {
  const database = new Database(':memory:')
  try {
    applyMigrations(database)
    const inventory = orchestratorIdentityInventory(database)
    expect(inventory.exempt).toHaveLength(EXEMPT_TABLES.length)
    expect(inventory.baseline).toHaveLength(IDENTITY_BASELINE.length)
  } finally {
    database.close()
  }
})

test('unknown and newly converted baseline tables are refused', () => {
  expect(() =>
    decideIdentityInventory([{ name: 'new_table', hasRequiredIdentity: false }], [], [], []),
  ).toThrow('add it to CONVERTED_TABLES, EXEMPT_TABLES with a reason, or IDENTITY_BASELINE')
  expect(() =>
    decideIdentityInventory([{ name: 'waiting', hasRequiredIdentity: true }], [], [], ['waiting']),
  ).toThrow('remove it from IDENTITY_BASELINE and add it to CONVERTED_TABLES')
})

test('integer primary keys and undeclared parent references are reported', () => {
  const inventory = classifyKeyInventory(
    'orchestrator',
    [
      {
        name: 'child',
        primaryKey: ['id'],
        columns: [
          { table: 'child', name: 'id', type: 'integer', primaryKey: true, foreignKey: false },
          {
            table: 'child',
            name: 'parent_id',
            type: 'integer',
            primaryKey: false,
            foreignKey: false,
          },
        ],
      },
    ],
    [],
    [],
  )
  expect(inventory.findings).toEqual(['child.parent_id:reference', 'child:primary-key'])
})

test('a reviewed integer handle may not become a foreign key', () => {
  expect(() =>
    classifyKeyInventory(
      'hub',
      [
        {
          name: 'note',
          primaryKey: ['record_id'],
          columns: [
            { table: 'note', name: 'record_id', type: 'uuid', primaryKey: true, foreignKey: false },
            { table: 'note', name: 'number', type: 'integer', primaryKey: false, foreignKey: true },
          ],
        },
      ],
      [{ store: 'hub', column: 'note.number', reason: 'display handle' }],
      [],
    ),
  ).toThrow('integer value note.number may not be a primary or foreign key')
})

test('a baseline entry that disappeared must be removed', () => {
  expect(() => assertShrinkingKeyBaseline('hosted', [], ['old:primary-key'])).toThrow(
    'baseline entries disappeared; remove them: old:primary-key',
  )
})
