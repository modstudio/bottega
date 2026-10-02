import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { resolveRunBase } from './run-base-resolution.ts'

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
