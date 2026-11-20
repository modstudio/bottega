import { expect, test } from 'bun:test'
import { ORCHESTRATOR_DATABASE_ENV, STATE_HOME_ENV } from '../../../shared/state-directory.ts'
import type { Project } from '../project/projects.ts'
import { areaReadPolicy, isAtOrBelow, ownProjectWorktreeDenies } from './area-read-policy.ts'
import { assembleAreaReadProfile } from './sandbox-area-read-profile.ts'

test('containment treats an entry beginning with two dots as inside its parent', () => {
  expect(isAtOrBelow('/projects/..foo', '/projects')).toBe(true)
})

test('area policy denies orchestrator database and runs overrides outside the state root', () => {
  const project: Project = {
    recordId: 'fixture-id',
    name: 'fixture',
    path: '/projects/fixture',
    stack: 'node',
    canon: true,
    retiredAt: null,
    settings: {},
  }
  const policy = areaReadPolicy({
    worktree: '/projects/fixture/.claude/worktrees/run',
    runtimeDir: '/override/runs/current',
    project,
    registeredProjects: [project],
    environment: {
      HOME: '/Users/operator',
      [STATE_HOME_ENV]: '/operator/state',
      [ORCHESTRATOR_DATABASE_ENV]: '/override/orchestrator/orchestrator.db',
      BOTTEGA_RUNS: '/override/runs',
    },
    worktreeDenyForm: 'live-glob',
    ownWorktreeRootEntries: [],
  })
  expect(policy.deny).toContain('/override/orchestrator')
  expect(policy.deny).toContain('/override/orchestrator/orchestrator.db')
  expect(policy.deny).toContain('/override/runs')
})

test('own-project worktree denies preserve owned carve-backs under the late-deny rule', () => {
  const project: Project = {
    recordId: 'own-id',
    name: 'own',
    path: '/projects/own',
    stack: 'node',
    canon: true,
    retiredAt: null,
    settings: {},
  }
  const worktree = '/projects/own/.claude/worktrees/run'
  const runtimeDir = '/operator/state/orchestrator/runs/current'
  const scratchDir = `${runtimeDir}/scratch`
  const areas = areaReadPolicy({
    worktree,
    runtimeDir,
    scratchDir,
    project,
    registeredProjects: [project],
    environment: { HOME: '/Users/operator', [STATE_HOME_ENV]: '/operator/state' },
    worktreeDenyForm: 'live-glob',
    ownWorktreeRootEntries: [],
  })
  const profile = assembleAreaReadProfile({
    areaDeny: areas.deny,
    candidateAllows: areas.allow,
    protectedDenies: [],
    socketDenyPaths: [],
  })

  for (const owned of [worktree, runtimeDir, scratchDir]) {
    for (const denied of profile.denyRead.filter((path) => isAtOrBelow(owned, path))) {
      expect(
        profile.allowWithinDeny.some(
          (allowed) => allowed !== denied && isAtOrBelow(denied, allowed),
        ),
      ).toBe(false)
    }
  }
  expect(profile.denyRead).toContain('/projects/own/.claude/worktrees/*')
  expect(profile.denyRead).not.toContain('/projects/own/.claude/worktrees')
})

test('Linux worktree denies enumerate existing siblings but not the own tree', () => {
  expect(
    ownProjectWorktreeDenies({
      root: '/projects/own/.claude/worktrees',
      worktree: '/projects/own/.claude/worktrees/run',
      form: 'launch-literal',
      entries: ['/projects/own/.claude/worktrees/run', '/projects/own/.claude/worktrees/sibling'],
    }),
  ).toEqual(['/projects/own/.claude/worktrees/sibling'])
})
