import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { STATE_HOME_ENV } from '../../../shared/state-directory.ts'
import { WORKER_RUNTIME_ASSETS } from '../../../shared/runtime-assets-in-sandbox.ts'
import type { Project } from '../project/projects.ts'
import { runningInstallReadCarveouts } from './install-read-policy.ts'
import { probeSandboxProfile, readonlyLensProfile, writerProfile } from './sandbox.ts'

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
  const installRoot = '/install'
  const installLayout = {
    kind: 'checkout' as const,
    root: installRoot,
    workspaceDirectories: ['/install/hub', '/install/orchestrator'],
  }
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
    installLayout,
  })

  expect(profile.filesystem.denyRead).toContain(installRoot)
  expect(profile.filesystem.allowWithinDeny).toEqual(
    expect.arrayContaining([
      '/install/bin',
      '/install/cli',
      '/install/shared',
      '/install/node_modules',
      '/install/package.json',
      '/install/hub',
      '/install/orchestrator',
    ]),
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

test('a distribution carves back its extracted sandbox runtime and no parent', () => {
  const runtimeRoot = '/operator/state/runtime/1.2.3/sandbox-runtime'
  expect(
    runningInstallReadCarveouts({
      kind: 'distribution',
      root: '/install',
      workspaceDirectories: [],
      extractedWorkerRuntimeAssetPaths: [runtimeRoot],
    }),
  ).toEqual(['/install', runtimeRoot])
})

test('distribution profiles carve back the extracted runtime beneath the denied state root', () => {
  const stateRoot = '/operator/state'
  const versionRoot = join(stateRoot, 'runtime', '1.2.3')
  const runtimeRoot = join(versionRoot, WORKER_RUNTIME_ASSETS.sandboxRuntime)
  const refGuard = join(versionRoot, WORKER_RUNTIME_ASSETS.refGuard)
  const environment = { HOME: '/Users/operator', [STATE_HOME_ENV]: stateRoot }
  const project = fixtureProject('fixture-id', 'fixture', '/projects/fixture')
  const installLayout = {
    kind: 'distribution' as const,
    root: '/install',
    workspaceDirectories: [],
    extractedWorkerRuntimeAssetPaths: [runtimeRoot, refGuard],
  }
  const readonly = readonlyLensProfile({
    worktree: '/projects/fixture/.claude/worktrees/run',
    runtimeDir: join(stateRoot, 'orchestrator', 'runs', 'run'),
    project,
    registeredProjects: [project],
    agent: 'grok',
    path: '/usr/bin',
    nodeModuleLinks: [],
    environment,
    socketDenyPaths: [],
    installLayout,
  })
  const probe = probeSandboxProfile({
    allowWriteDir: join(stateRoot, 'orchestrator', 'runs', 'probe', 'scratch'),
    cwd: '/projects/fixture/.claude/worktrees/run',
    project,
    registeredProjects: [project],
    environment,
    socketDenyPaths: [],
    installLayout,
  })

  for (const profile of [readonly, probe]) {
    expect(profile.filesystem.denyRead).toContain(stateRoot)
    expect(profile.filesystem.allowWithinDeny).toContain(runtimeRoot)
    expect(profile.filesystem.allowWithinDeny).toContain(refGuard)
    expect(profile.filesystem.allowWithinDeny).not.toContain(join(stateRoot, 'runtime'))
    expect(profile.filesystem.allowWithinDeny).not.toContain(join(stateRoot, 'runtime', '1.2.3'))
  }
})

test('a distribution writer can read the extracted ref guard under the denied state root', () => {
  const stateRoot = '/operator/state'
  const versionRoot = join(stateRoot, 'runtime', '1.2.3')
  const runtimeRoot = join(versionRoot, WORKER_RUNTIME_ASSETS.sandboxRuntime)
  const refGuard = join(versionRoot, WORKER_RUNTIME_ASSETS.refGuard)
  const environment = { HOME: '/Users/operator', [STATE_HOME_ENV]: stateRoot }
  const project = fixtureProject('fixture-id', 'fixture', '/projects/fixture')
  const profile = writerProfile({
    worktree: '/projects/fixture/.claude/worktrees/run',
    runtimeDir: join(stateRoot, 'orchestrator', 'runs', 'run'),
    scratchDir: join(stateRoot, 'orchestrator', 'runs', 'run', 'scratch'),
    askAddress: '127.0.0.1:1',
    project,
    registeredProjects: [project],
    agent: 'grok',
    path: '/usr/bin',
    nodeModuleLinks: [],
    environment,
    socketDenyPaths: [],
    installLayout: {
      kind: 'distribution',
      root: '/install',
      workspaceDirectories: [],
      extractedWorkerRuntimeAssetPaths: [runtimeRoot, refGuard],
    },
  })

  expect(profile.filesystem.denyRead).toContain(stateRoot)
  expect(profile.filesystem.allowWithinDeny).toContain(refGuard)
})
