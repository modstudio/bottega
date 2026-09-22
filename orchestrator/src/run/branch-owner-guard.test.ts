import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { assertBranchHasNoAliveOwner } from './branch-owner-guard.ts'

test('an absent branch needs no owner lookup', () => {
  expect(() =>
    assertBranchHasNoAliveOwner({
      branch: undefined,
      conversationRootId: null,
      projectId: null,
      projectName: null,
    }),
  ).not.toThrow()
})

test('an alive owner refusal names the landing-tree retry command', () => {
  const branch = 'DEV-838-orch-1'
  const owner = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
  db().query('UPDATE run SET branch=?, repo=? WHERE id=?').run(branch, 'fixture', owner)

  expect(() =>
    assertBranchHasNoAliveOwner({
      branch,
      conversationRootId: null,
      projectId: null,
      projectName: 'fixture',
      retryCommand: 'orch tree open 41',
    }),
  ).toThrow('then retry orch tree open 41')
})
