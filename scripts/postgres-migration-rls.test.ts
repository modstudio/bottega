import { expect, test } from 'bun:test'
import { analyzeForcedRlsDml } from './postgres-migration-rls.ts'

test('rejects an update while FORCE ROW LEVEL SECURITY is active', () => {
  expect(analyzeForcedRlsDml('UPDATE "doc" SET body = body;', new Set(['doc'])).findings).toEqual([
    { table: 'doc', operation: 'UPDATE', reason: 'force-enabled' },
  ])
})

test('accepts an update bracketed by lifting and restoring FORCE ROW LEVEL SECURITY', () => {
  const result = analyzeForcedRlsDml(
    `ALTER TABLE "doc" NO FORCE ROW LEVEL SECURITY;
     UPDATE "doc" SET body = body;
     ALTER TABLE "doc" FORCE ROW LEVEL SECURITY;`,
    new Set(['doc']),
  )
  expect(result.findings).toEqual([])
  expect(result.forcedTables).toEqual(new Set(['doc']))
})

test('accepts DML on a table without FORCE ROW LEVEL SECURITY', () => {
  expect(analyzeForcedRlsDml('DELETE FROM audit_log;', new Set(['doc'])).findings).toEqual([])
})

test('rejects a lifted update when FORCE ROW LEVEL SECURITY is not restored', () => {
  expect(
    analyzeForcedRlsDml(
      'ALTER TABLE doc NO FORCE ROW LEVEL SECURITY; INSERT INTO doc (id) VALUES (1);',
      new Set(['doc']),
    ).findings,
  ).toEqual([{ table: 'doc', operation: 'INSERT', reason: 'force-not-restored' }])
})
