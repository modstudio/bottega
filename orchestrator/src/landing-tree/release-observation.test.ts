import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { addRun, dir } from '../../test/fixtures/store.ts'
import { upsertProject } from '../project/projects.ts'
import { LANDING_TREE_JOB } from '../run/synthetic-lifecycle-job.ts'
import { observeLandingTreeRelease } from './release-observation.ts'

test('an absent terminal landing tree is releasable unless its branch is landing', () => {
  const id = addRun({ agent: '(architect)', job: LANDING_TREE_JOB, status: 'ok' })
  const project = `absent-landing-observation-${id}`
  const branch = `DEV-1023-orch-${id}`
  upsertProject({ name: project, path: join(dir, project), settings: { trunk: 'main' } })
  const row = {
    job: LANDING_TREE_JOB,
    repo: project,
    worktree: join(dir, project, '.claude', 'worktrees', `orch-${id}-land`),
    branch,
    sessionId: 'owner',
    launchKey: 'DEV-1023',
    status: 'ok',
    treeExists: false,
    landingInFlight: false,
  }

  expect(observeLandingTreeRelease(row)).toEqual({ action: 'release' })
  expect(observeLandingTreeRelease({ ...row, landingInFlight: true })).toEqual({
    action: 'keep',
    reason: 'landing tree held by session owner: landing is in flight',
  })
})
