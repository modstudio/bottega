import { expect, test } from 'bun:test'
import {
  cascadeRefusal,
  cascadeRisks,
  probeMigrations,
  validateCascadeExemptions,
} from './check-cascade-preservation.ts'

const schema = `
CREATE TABLE parent (id INTEGER PRIMARY KEY);
CREATE TABLE child (
  id INTEGER PRIMARY KEY,
  parent_id INTEGER REFERENCES parent(id) ON DELETE CASCADE
);`

test('refuses deleting a parent without preserving its cascading dependent', () => {
  const risks = cascadeRisks([
    { tag: '0000_schema', source: schema },
    { tag: '0001_rebuild', source: 'DELETE FROM parent;' },
  ])
  expect(risks).toEqual([
    {
      migration: '0001_rebuild',
      deletedTable: 'parent',
      dependentTable: 'child',
      detectedBy: ['parse', 'replay'],
    },
  ])
  expect(cascadeRefusal(risks)).toContain(
    'deletes or drops parent, which would cascade-delete child; add child',
  )
})

test('accepts a migration that copies, deletes, and restores the dependent', () => {
  expect(
    cascadeRisks([
      { tag: '0000_schema', source: schema },
      {
        tag: '0001_rebuild',
        source: `
          CREATE TEMP TABLE parent_before AS SELECT * FROM parent;
          CREATE TEMP TABLE child_before AS SELECT * FROM child;
          DELETE FROM child;
          DELETE FROM parent;
          INSERT INTO parent SELECT * FROM parent_before;
          INSERT INTO child SELECT * FROM child_before;
          DROP TABLE child_before;`,
      },
    ]),
  ).toEqual([])
})

test('recognizes a quoted destructive table name', () => {
  expect(
    cascadeRisks([
      {
        tag: '0000_schema',
        source: `
          CREATE TABLE "parent-table" (id INTEGER PRIMARY KEY);
          CREATE TABLE child (
            id INTEGER PRIMARY KEY,
            parent_id INTEGER REFERENCES "parent-table"(id) ON DELETE CASCADE
          );`,
      },
      { tag: '0001_rebuild', source: 'DELETE FROM "parent-table";' },
    ]),
  ).toEqual([
    {
      migration: '0001_rebuild',
      deletedTable: 'parent-table',
      dependentTable: 'child',
      detectedBy: ['parse', 'replay'],
    },
  ])
})

test('recognizes a schema-qualified destructive table name', () => {
  expect(
    cascadeRisks([
      { tag: '0000_schema', source: schema },
      { tag: '0001_rebuild', source: 'DELETE FROM main.parent;' },
    ]),
  ).toEqual([
    {
      migration: '0001_rebuild',
      deletedTable: 'parent',
      dependentTable: 'child',
      detectedBy: ['parse', 'replay'],
    },
  ])
})

test('refuses a restore that occurs before the destructive statement', () => {
  expect(
    cascadeRisks([
      { tag: '0000_schema', source: schema },
      {
        tag: '0001_rebuild',
        source: `
          CREATE TEMP TABLE child_before AS SELECT * FROM child;
          DELETE FROM child;
          INSERT INTO child SELECT * FROM child_before;
          DELETE FROM parent;`,
      },
    ]),
  ).toEqual([
    {
      migration: '0001_rebuild',
      deletedTable: 'parent',
      dependentTable: 'child',
      detectedBy: ['parse'],
    },
  ])
})

test('accepts explicit columns in the preservation copy and restore', () => {
  expect(
    cascadeRisks([
      { tag: '0000_schema', source: schema },
      {
        tag: '0001_rebuild',
        source: `
          CREATE TEMP TABLE parent_before AS SELECT id FROM parent;
          CREATE TEMP TABLE child_before AS SELECT id, parent_id FROM child;
          DELETE FROM child;
          DELETE FROM parent;
          INSERT INTO parent(id) SELECT id FROM parent_before;
          INSERT INTO child(id, parent_id) SELECT id, parent_id FROM child_before;`,
      },
    ]),
  ).toEqual([])
})

test('execution probe observes a cascading row loss', () => {
  expect(
    probeMigrations([
      { tag: '0000_schema', source: schema },
      { tag: '0001_rebuild', source: 'DELETE FROM parent;' },
    ]).risks,
  ).toEqual([
    {
      migration: '0001_rebuild',
      deletedTable: 'parent',
      dependentTable: 'child',
      detectedBy: ['replay'],
    },
  ])
})

test('execution probe chooses a value permitted by a CHECK constraint', () => {
  const result = probeMigrations([
    {
      tag: '0000_schema',
      source: `
        CREATE TABLE parent (id INTEGER PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('ready','done')));
        CREATE TABLE child (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER NOT NULL REFERENCES parent(id) ON DELETE CASCADE,
          verdict TEXT NOT NULL CHECK(verdict IN ('accepted','rejected'))
        );`,
    },
    { tag: '0001_rebuild', source: 'DELETE FROM parent;' },
  ])

  expect(result.unprobed).toEqual([])
  expect(result.risks).toEqual([
    {
      migration: '0001_rebuild',
      deletedTable: 'parent',
      dependentTable: 'child',
      detectedBy: ['replay'],
    },
  ])
})

test('execution probe seeds nullable exclusive-or columns with an integer flag', () => {
  const result = probeMigrations([
    {
      tag: '0000_schema',
      source: `
        CREATE TABLE parent (id INTEGER PRIMARY KEY);
        CREATE TABLE child (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER NOT NULL REFERENCES parent(id) ON DELETE CASCADE,
          left_value TEXT,
          right_value TEXT,
          active_side INTEGER NOT NULL CHECK(active_side IN (0,1)),
          CHECK((left_value IS NULL) <> (right_value IS NULL)),
          CHECK(
            (active_side = 0 AND left_value IS NOT NULL AND right_value IS NULL) OR
            (active_side = 1 AND left_value IS NULL AND right_value IS NOT NULL)
          )
        );`,
    },
    { tag: '0001_rebuild', source: 'DELETE FROM parent;' },
  ])

  expect(result.unprobed).toEqual([])
  expect(result.risks).toEqual([
    {
      migration: '0001_rebuild',
      deletedTable: 'parent',
      dependentTable: 'child',
      detectedBy: ['replay'],
    },
  ])
})

test('names a table whose CHECK constraints cannot be satisfied mechanically', () => {
  const result = probeMigrations([
    {
      tag: '0000_schema',
      source: `
        CREATE TABLE parent (id INTEGER PRIMARY KEY);
        CREATE TABLE child (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER NOT NULL REFERENCES parent(id) ON DELETE CASCADE,
          impossible INTEGER NOT NULL CHECK(impossible > 0 AND impossible < 0)
        );`,
    },
    { tag: '0001_rebuild', source: 'DELETE FROM parent;' },
  ])

  expect(result.unprobed).toHaveLength(1)
  expect(result.unprobed[0]).toMatchObject({ migration: '0001_rebuild', table: 'child' })
})

test('refuses the 0041 shape when a restored parent loses its cascading dependent', () => {
  const migrations = [
    { tag: '0000_schema', source: schema },
    {
      tag: '0041_parent_rebuild',
      source: `
        CREATE TEMP TABLE parent_before AS SELECT * FROM parent;
        DELETE FROM parent;
        INSERT INTO parent SELECT * FROM parent_before;
        DROP TABLE parent_before;`,
    },
  ]
  const risks = cascadeRisks(migrations)

  expect(risks).toEqual([
    {
      migration: '0041_parent_rebuild',
      deletedTable: 'parent',
      dependentTable: 'child',
      detectedBy: ['parse', 'replay'],
    },
  ])
  expect(cascadeRefusal(risks)).toContain(
    '0041_parent_rebuild [parse+replay] deletes or drops parent, which would cascade-delete child',
  )
})

test('accepts a migration with no destructive statement', () => {
  expect(
    cascadeRisks([
      { tag: '0000_schema', source: schema },
      { tag: '0001_additive', source: 'CREATE INDEX child_parent ON child(parent_id);' },
    ]),
  ).toEqual([])
})

test('an exemption cannot omit its task and remedy', () => {
  expect(() =>
    validateCascadeExemptions([
      {
        migration: '0001_rebuild',
        deletedTable: 'parent',
        dependentTable: 'child',
        remedy: 'explained elsewhere',
      },
    ]),
  ).toThrow('needs a DEV task and remedy')
})
