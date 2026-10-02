import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { resolveRunBase, shouldResolveRunBase } from './run-base-resolution.ts'

test('an unresolved recorded commit refusal names both the commit and launch branch', () => {
  const root = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
  db()
    .query('UPDATE run SET launch_base=?,base_commit=? WHERE id=?')
    .run('DEV-1042-orch-8083', '956304fe', root)

  expect(() =>
    resolveRunBase({ cwd: '/checkout', base: '956304fe', resumeParent: root }, db(), () => {
      throw new Error('missing object')
    }),
  ).toThrow(
    'cannot resolve recorded base commit 956304fe for launch branch DEV-1042-orch-8083: missing object',
  )
})

test("a read-only run's base is not resolved in the caller checkout", () => {
  expect(shouldResolveRunBase('topic', '/registered/project')).toBeFalse()
  expect(shouldResolveRunBase('topic', null)).toBeTrue()

  const source = readFileSync(new URL('./run.ts', import.meta.url), 'utf8')
  const readOnlyResolution = source.indexOf('const readOnlyBase =')
  const writableResolution = source.indexOf('resolveRunBase({', readOnlyResolution)
  const guardedResolution = source.slice(readOnlyResolution, writableResolution)

  expect(readOnlyResolution).toBeGreaterThanOrEqual(0)
  expect(writableResolution).toBeGreaterThan(readOnlyResolution)
  expect(guardedResolution).toContain('if (shouldResolveRunBase(opts.base, readOnlyBase))')
})
