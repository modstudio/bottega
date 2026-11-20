import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { STATE_HOME_ENV } from '../../../shared/state-directory.ts'
import type { Project } from '../project/projects.ts'
import {
  runningInstallReadCarveouts,
  runningInstallRootForSandbox,
} from './install-read-policy.ts'
import { readonlyLensProfile } from './sandbox.ts'

function fixtureProject(recordId: string, name: string, path: string): Project {
  return {
    recordId,
    name,
    path,
    stack: 'node',
    canon: true,
    retiredAt: null,
    settings: {},
  }
}

test('a different project can read only the running checkout runtime', () => {
  const environment = { HOME: '/Users/operator', [STATE_HOME_ENV]: '/operator/state' }
  const installRoot = runningInstallRootForSandbox(environment)
  const own = fixtureProject('other-project-id', 'other-project', '/projects/other-project')
  const install = fixtureProject('install-project-id', PLATFORM_SLUG, installRoot)
  const profile = readonlyLensProfile({
    worktree: '/projects/other-project/.worktrees/run',
    runtimeDir: '/operator/state/orchestrator/runs/sandbox-run',
    project: own,
    registeredProjects: [own, install],
    agent: 'grok',
    path: '/usr/bin',
    nodeModuleLinks: [],
    environment,
    socketDenyPaths: [],
  })

  expect(profile.filesystem.denyRead).toContain(installRoot)
  expect(profile.filesystem.allowWithinDeny).toEqual(
    expect.arrayContaining(runningInstallReadCarveouts(environment)),
  )
  expect(profile.filesystem.allowWithinDeny).not.toContain(installRoot)
  for (const sensitive of [join(installRoot, '.env'), join(installRoot, '.claude')]) {
    expect(
      profile.filesystem.allowWithinDeny.some(
        (allowed) => sensitive === allowed || sensitive.startsWith(`${allowed}/`),
      ),
    ).toBe(false)
  }
})
