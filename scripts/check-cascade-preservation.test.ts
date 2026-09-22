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
    { migration: '0001_rebuild', deletedTable: 'parent', dependentTable: 'child' },
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
  ).toEqual([{ migration: '0001_rebuild', deletedTable: 'parent-table', dependentTable: 'child' }])
})

test('recognizes a schema-qualified destructive table name', () => {
  expect(
    cascadeRisks([
      { tag: '0000_schema', source: schema },
      { tag: '0001_rebuild', source: 'DELETE FROM main.parent;' },
    ]),
  ).toEqual([{ migration: '0001_rebuild', deletedTable: 'parent', dependentTable: 'child' }])
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
  ).toEqual([{ migration: '0001_rebuild', deletedTable: 'parent', dependentTable: 'child' }])
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
  ).toEqual([{ migration: '0001_rebuild', deletedTable: 'parent', dependentTable: 'child' }])
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
