import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { PLATFORM_NAME, PLATFORM_SLUG } from '../../../shared/brand.ts'
import { registerEmbeddedAssets } from '../../../shared/embedded-assets.ts'
import { WORKER_RUNTIME_ASSETS } from '../../../shared/runtime-assets-in-sandbox.ts'
import { STATE_HOME_ENV } from '../../../shared/state-directory.ts'
import type { Project } from '../project/projects.ts'
import { runningInstallProbeTarget, runningInstallReadCarveouts } from './install-read-policy.ts'
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

test('running install carve-backs contain install paths only', () => {
  expect(
    runningInstallReadCarveouts({
      kind: 'distribution',
      root: '/install',
      workspaceDirectories: [],
    }),
  ).toEqual(['/install'])
})

test('running install probe targets metadata shipped by each install kind', () => {
  expect(
    runningInstallProbeTarget({
      kind: 'checkout',
      root: '/checkout',
      workspaceDirectories: [],
    }),
  ).toEqual({ name: 'running checkout package.json', path: '/checkout/package.json' })
  expect(
    runningInstallProbeTarget({
      kind: 'distribution',
      root: '/distribution',
      workspaceDirectories: [],
    }),
  ).toEqual({
    name: 'running distribution manifest',
    path: `/distribution/.${PLATFORM_SLUG}-dist.json`,
  })
})

test('embedded runtime assets are carved back for every area profile regardless of install layout', () => {
  const stateRoot = '/operator/state'
  const versionRoot = join(stateRoot, 'runtime', '1.2.3')
  const runtimeRoot = join(versionRoot, WORKER_RUNTIME_ASSETS.sandboxRuntime)
  const refGuard = join(versionRoot, WORKER_RUNTIME_ASSETS.refGuard)
  const environment = { HOME: '/Users/operator', [STATE_HOME_ENV]: stateRoot }
  const project = fixtureProject('fixture-id', 'fixture', '/projects/fixture')
  const distributionManifest = {
    name: PLATFORM_NAME,
    version: '1.2.3',
    built: '2026-11-20T00:00:00.000Z',
    commit: 'fixture',
  } as const
  registerEmbeddedAssets({ assets: {}, files: {}, manifest: distributionManifest })
  const installLayout = {
    kind: 'checkout' as const,
    root: '/install',
    workspaceDirectories: ['/install/orchestrator'],
  }
  const common = {
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
  }
  const readonly = readonlyLensProfile(common)
  const probe = probeSandboxProfile({
    ...common,
    allowWriteDir: join(stateRoot, 'orchestrator', 'runs', 'probe', 'scratch'),
    cwd: '/projects/fixture/.claude/worktrees/run',
  })
  const writer = writerProfile({
    ...common,
    scratchDir: join(stateRoot, 'orchestrator', 'runs', 'run', 'scratch'),
    askAddress: '127.0.0.1:1',
  })

  for (const profile of [readonly, probe, writer]) {
    expect(profile.filesystem.denyRead).toContain(stateRoot)
    expect(profile.filesystem.allowWithinDeny).toContain(runtimeRoot)
    expect(profile.filesystem.allowWithinDeny).toContain(refGuard)
    expect(profile.filesystem.allowWithinDeny).not.toContain(join(stateRoot, 'runtime'))
    expect(profile.filesystem.allowWithinDeny).not.toContain(join(stateRoot, 'runtime', '1.2.3'))
  }

  registerEmbeddedAssets(null)
  const withoutManifest = common
  const profilesWithoutManifest = [
    readonlyLensProfile(withoutManifest),
    probeSandboxProfile({
      ...withoutManifest,
      allowWriteDir: join(stateRoot, 'orchestrator', 'runs', 'probe', 'scratch'),
      cwd: '/projects/fixture/.claude/worktrees/run',
    }),
    writerProfile({
      ...withoutManifest,
      scratchDir: join(stateRoot, 'orchestrator', 'runs', 'run', 'scratch'),
      askAddress: '127.0.0.1:1',
    }),
  ]
  for (const profile of profilesWithoutManifest) {
    expect(profile.filesystem.allowWithinDeny).not.toContain(runtimeRoot)
    expect(profile.filesystem.allowWithinDeny).not.toContain(refGuard)
  }
})
