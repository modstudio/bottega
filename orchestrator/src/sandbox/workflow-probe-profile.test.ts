import { expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  ORCHESTRATOR_DATABASE_ENV,
  resolveOrchestratorDatabase,
  STATE_HOME_ENV,
} from '../../../shared/state-directory.ts'
import type { Project } from '../project/projects.ts'
import { probeSandboxProfile, readonlyLensProfile } from './sandbox.ts'

test('agent profiles deny the orchestrator store while a workflow probe reads its directory', () => {
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
  const common = {
    project,
    registeredProjects: [project],
    environment,
    socketDenyPaths: [],
  }
  const agent = readonlyLensProfile({
    ...common,
    worktree: '/projects/fixture/.worktrees/run',
    runtimeDir: '/override/orchestrator/runs/agent',
    agent: 'grok',
    path: '/usr/bin',
    nodeModuleLinks: [],
    installLayout: { kind: 'distribution', root: '/install', workspaceDirectories: [] },
    orchestratorStoreAccess: 'deny',
  })
  const workflow = probeSandboxProfile({
    ...common,
    allowWriteDir: '/override/orchestrator/runs/workflow/scratch',
    cwd: '/projects/fixture/.worktrees/run',
    orchestratorStoreAccess: 'allow-read',
  })
  const store = resolveOrchestratorDatabase(environment)

  expect(agent.filesystem.denyRead).toContain(store)
  expect(agent.filesystem.allowWithinDeny).not.toContain(store)
  expect(workflow.filesystem.denyRead).not.toContain(join(store, '..'))
  expect(workflow.filesystem.denyRead).not.toContain(store)
  expect(workflow.filesystem.allowWithinDeny).toEqual(
    expect.arrayContaining([join(store, '..'), store, `${store}-wal`, `${store}-shm`]),
  )
  expect(workflow.filesystem.denyRead).toContain('/override/orchestrator/runs')
})
