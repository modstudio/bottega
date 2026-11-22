import { expect, test } from 'bun:test'
import { canonMirrorRevertRefusal } from './canon-mirror-revert-guard.ts'

const commit = { sha: 'abcdef0123456789', at: '2026-11-20T00:00:00Z' }

test('write guard refuses a branch-newer file and permits a row-newer file', () => {
  const refused = canonMirrorRevertRefusal({
    project: 'fixture',
    path: '.agents/rules/a.md',
    operation: 'write',
    commit,
    rowRevisionAt: '2026-11-19T00:00:00Z',
    removalAt: null,
    newestCanonAt: null,
  })
  expect(refused).toContain('.agents/rules/a.md')
  expect(refused).toContain('abcdef0123')
  expect(refused).toContain('doc set --scope canon --subject fixture')
  expect(
    canonMirrorRevertRefusal({
      project: 'fixture',
      path: '.agents/rules/a.md',
      operation: 'write',
      commit,
      rowRevisionAt: '2026-11-21T00:00:00Z',
      removalAt: null,
      newestCanonAt: null,
    }),
  ).toBeNull()
})

test('delete guard covers branch additions and timed retirements', () => {
  expect(
    canonMirrorRevertRefusal({
      project: 'fixture',
      path: '.agents/rules/new.md',
      operation: 'delete',
      commit,
      rowRevisionAt: null,
      removalAt: null,
      newestCanonAt: '2026-11-19T00:00:00Z',
    }),
  ).toContain('new.md')
  expect(
    canonMirrorRevertRefusal({
      project: 'fixture',
      path: '.agents/rules/retired.md',
      operation: 'delete',
      commit,
      rowRevisionAt: '2026-11-21T00:00:00Z',
      removalAt: '2026-11-21T00:00:00Z',
      newestCanonAt: null,
    }),
  ).toBeNull()
  expect(
    canonMirrorRevertRefusal({
      project: 'fixture',
      path: '.agents/rules/retired.md',
      operation: 'delete',
      commit,
      rowRevisionAt: '2026-11-19T00:00:00Z',
      removalAt: '2026-11-19T00:00:00Z',
      newestCanonAt: null,
    }),
  ).toContain('retired.md')
})

test('a generated write with no row revision remains unguarded', () => {
  expect(
    canonMirrorRevertRefusal({
      project: 'fixture',
      path: 'AGENTS.override.md',
      operation: 'write',
      commit,
      rowRevisionAt: null,
      removalAt: null,
      newestCanonAt: '2026-11-19T00:00:00Z',
    }),
  ).toBeNull()
})
