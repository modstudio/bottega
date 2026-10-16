import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { projectByName, upsertProject } from '../project/projects.ts'
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
  upsertProject({ name: 'fixture', path: '/fixture' })
  const projectId = projectByName('fixture')!.id
  const owner = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
  db()
    .query('UPDATE run SET branch=?, project_id=?, repo=? WHERE id=?')
    .run(branch, projectId, 'fixture', owner)

  expect(() =>
    assertBranchHasNoAliveOwner({
      branch,
      conversationRootId: null,
      projectId,
      projectName: 'fixture',
      retryCommand: `${PLATFORM_SLUG} tree open 41`,
    }),
  ).toThrow(`then retry ${PLATFORM_SLUG} tree open 41`)
})
