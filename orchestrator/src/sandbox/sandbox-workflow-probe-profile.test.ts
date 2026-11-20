import { expect, test } from 'bun:test'
import {
  ORCHESTRATOR_DATABASE_ENV,
  resolveOrchestratorDatabase,
  STATE_HOME_ENV,
} from '../../../shared/state-directory.ts'
import type { Project } from '../project/projects.ts'
import { probeSandboxProfile } from './sandbox.ts'

test('the shared probe profile denies areas and protected secrets', () => {
  const project: Project = {
    recordId: 'fixture-id',
    name: 'fixture',
    path: '/projects/fixture',
    stack: 'node',
    canon: true,
    retiredAt: null,
    settings: { secretPaths: ['operator.secret'] },
  }
  const environment = {
    HOME: '/Users/operator',
    [STATE_HOME_ENV]: '/operator/state',
    [ORCHESTRATOR_DATABASE_ENV]: '/override/orchestrator/orchestrator.db',
  }
  const input = {
    allowWriteDir: '/override/orchestrator/runs/probe/scratch',
    cwd: '/projects/fixture/.worktrees/run',
    project,
    registeredProjects: [project],
    environment,
    socketDenyPaths: [],
  }
  const profile = probeSandboxProfile(input)
  const store = resolveOrchestratorDatabase(environment)
  const secret = '/projects/fixture/operator.secret'

  expect(profile.filesystem.denyRead).toContain(store)
  expect(profile.filesystem.denyRead).toContain('/override/orchestrator/runs')
  expect(profile.filesystem.allowWithinDeny).not.toContain(store)
  expect(profile.filesystem.denyRead).toContain(secret)
  expect(profile.network.allowedDomains).toEqual(['localhost', '127.0.0.1', '[::1]'])
  expect(profile.network.allowLocalBinding).toBe(true)
  expect(profile.network.deniedDomains).toEqual([])
  expect(profile.network.allowUnixSockets).toEqual([])
})
