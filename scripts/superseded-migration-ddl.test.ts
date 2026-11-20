import { expect, test } from 'bun:test'
import { normalizeSupersededDdl } from './superseded-migration-ddl.ts'

test('normalizes an expression-valued guard and its literal replacement equally', () => {
  const predecessor = `
    CREATE TRIGGER guard BEFORE INSERT ON findings BEGIN
      SELECT RAISE(ABORT, NEW.detail);
    END;
  `
  const replacement = `
    CREATE TRIGGER guard BEFORE INSERT ON findings
    BEGIN SELECT RAISE(ABORT, 'repair the rows, then migrate'); END;
  `

  expect(normalizeSupersededDdl(predecessor)).toBe(normalizeSupersededDdl(replacement))
})

test('normalizes a RAISE literal containing an escaped quote, comma, and parenthesis', () => {
  expect(normalizeSupersededDdl("SELECT RAISE(FAIL, 'can''t continue, repair (rows)');")).toBe(
    "SELECT RAISE(FAIL,'__SUPERSEDED_RAISE_MESSAGE__');",
  )
})

test('leaves RAISE text inside a SQL literal unchanged', () => {
  expect(
    normalizeSupersededDdl("INSERT INTO log(message) VALUES ('RAISE(ABORT, NEW.detail)');"),
  ).toBe("INSERT INTO log(message) VALUES ('RAISE(ABORT, NEW.detail)');")
})

test('does not normalize schema or other statement changes', () => {
  const original = `CREATE TABLE finding (id INTEGER); SELECT RAISE(ROLLBACK, finding.detail);`
  expect(normalizeSupersededDdl(original)).not.toBe(
    normalizeSupersededDdl(
      `CREATE TABLE finding (id INTEGER, detail TEXT); SELECT RAISE(ROLLBACK, 'repair');`,
    ),
  )
  expect(normalizeSupersededDdl(original)).not.toBe(
    normalizeSupersededDdl(
      `CREATE TABLE finding (id INTEGER); DELETE FROM finding; SELECT RAISE(ROLLBACK, 'repair');`,
    ),
  )
})
