import { expect, test } from 'bun:test'
import { ORCHESTRATOR_DATABASE_ENV, STATE_HOME_ENV } from '../../../shared/state-directory.ts'
import type { Project } from '../project/projects.ts'
import { areaReadPolicy } from './area-read-policy.ts'

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
    orchestratorStoreAccess: 'deny',
    environment: {
      HOME: '/Users/operator',
      [STATE_HOME_ENV]: '/operator/state',
      [ORCHESTRATOR_DATABASE_ENV]: '/override/orchestrator/orchestrator.db',
      BOTTEGA_RUNS: '/override/runs',
    },
  })
  expect(policy.deny).toContain('/override/orchestrator')
  expect(policy.deny).toContain('/override/orchestrator/orchestrator.db')
  expect(policy.deny).toContain('/override/runs')
})

test('workflow access carves back only the orchestrator store and its WAL view', () => {
  const project: Project = {
    recordId: 'fixture-id',
    name: 'fixture',
    path: '/projects/fixture',
    stack: 'node',
    canon: true,
    retiredAt: null,
    settings: {},
  }
  const environment = {
    HOME: '/Users/operator',
    [STATE_HOME_ENV]: '/operator/state',
    [ORCHESTRATOR_DATABASE_ENV]: '/override/orchestrator/orchestrator.db',
  }
  const agentPolicy = areaReadPolicy({
    worktree: '/projects/fixture/.claude/worktrees/run',
    runtimeDir: '/operator/state/orchestrator/runs/current',
    project,
    registeredProjects: [project],
    environment,
    orchestratorStoreAccess: 'deny',
  })
  const workflowPolicy = areaReadPolicy({
    worktree: '/projects/fixture/.claude/worktrees/run',
    runtimeDir: '/operator/state/orchestrator/runs/current',
    project,
    registeredProjects: [project],
    environment,
    orchestratorStoreAccess: 'allow-read',
  })

  const store = '/override/orchestrator/orchestrator.db'
  expect(agentPolicy.deny).toEqual(expect.arrayContaining(['/override/orchestrator', store]))
  expect(agentPolicy.allow).not.toContain(store)
  expect(workflowPolicy.deny).not.toContain('/override/orchestrator')
  expect(workflowPolicy.deny).not.toContain(store)
  expect(workflowPolicy.allow).toEqual(
    expect.arrayContaining(['/override/orchestrator', store, `${store}-wal`, `${store}-shm`]),
  )
  expect(workflowPolicy.deny).toContain('/override/orchestrator/runs')
})
