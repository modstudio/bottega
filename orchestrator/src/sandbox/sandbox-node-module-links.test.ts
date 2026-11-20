import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { STATE_HOME_ENV } from '../../../shared/state-directory.ts'
import type { Project } from '../project/projects.ts'
import { permittedNodeModuleCarvebacks } from './node-module-read-carvebacks.ts'
import { readonlyLensProfile } from './sandbox.ts'

const fixtureProject = (path = '/projects/fixture'): Project => ({
  recordId: '01990000-0000-7000-8000-000000001214',
  name: 'fixture',
  path,
  stack: 'node',
  canon: true,
  retiredAt: null,
  settings: {},
})

const profileForLinks = (input: {
  project: Project
  registeredProjects?: Project[]
  links: string[]
  environment?: Record<string, string>
  warnings: string[]
  platform?: 'darwin' | 'linux'
  ownWorktreeRootEntries?: string[]
}) =>
  readonlyLensProfile({
    worktree: '/runs/tree',
    runtimeDir: '/runs/evidence',
    project: input.project,
    registeredProjects: input.registeredProjects ?? [input.project],
    agent: 'grok',
    path: '/usr/bin',
    nodeModuleLinks: input.links,
    environment: input.environment,
    installLayout: {
      kind: 'distribution',
      root: '/install',
      workspaceDirectories: [],
    },
    onWarning: (message) => input.warnings.push(message),
    platform: input.platform,
    ownWorktreeRootEntries: input.ownWorktreeRootEntries,
  })

test('a node_modules link into another registered project is not re-allowed', () => {
  const own = fixtureProject()
  const sibling = { ...fixtureProject('/projects/sibling'), recordId: 'sibling-id' }
  const warnings: string[] = []
  const profile = profileForLinks({
    project: own,
    registeredProjects: [own, sibling],
    links: ['/projects/sibling/node_modules'],
    warnings,
  })

  expect(profile.filesystem.allowWithinDeny).not.toContain('/projects/sibling/node_modules')
  expect(warnings).toEqual([expect.stringContaining('/projects/sibling/node_modules')])
})

test('a node_modules link into per-user state is not re-allowed', () => {
  const state = '/operator/state'
  const warnings: string[] = []
  const link = join(state, 'shared-node_modules')
  const profile = profileForLinks({
    project: fixtureProject(),
    links: [link],
    environment: { HOME: '/Users/operator', [STATE_HOME_ENV]: state },
    warnings,
  })

  expect(profile.filesystem.allowWithinDeny).not.toContain(link)
  expect(warnings).toEqual([expect.stringContaining(link)])
})

test('a node_modules link under the run project main checkout stays re-allowed', () => {
  const warnings: string[] = []
  const link = '/projects/fixture/packages/ui/node_modules'
  const profile = profileForLinks({
    project: fixtureProject(),
    links: [link],
    warnings,
  })

  expect(profile.filesystem.allowWithinDeny).toContain(link)
  expect(warnings).toEqual([])
})

for (const platform of ['darwin', 'linux'] as const) {
  test(`a node_modules link into a sibling worktree is not re-allowed on ${platform}`, () => {
    const warnings: string[] = []
    const sibling = '/projects/fixture/.claude/worktrees/other-run'
    const link = `${sibling}/node_modules`
    const profile = profileForLinks({
      project: fixtureProject(),
      links: [link],
      warnings,
      platform,
      ownWorktreeRootEntries: platform === 'linux' ? [sibling] : [],
    })

    expect(profile.filesystem.allowWithinDeny).not.toContain(link)
    expect(warnings).toEqual([expect.stringContaining(link)])
  })
}

test('an area deny must be strictly inside the root that admits a node_modules link', () => {
  const root = '/install'
  const allowedLink = '/install/node_modules'
  const deniedLink = '/install/private/node_modules'
  const warnings: string[] = []

  const carvebacks = permittedNodeModuleCarvebacks({
    links: [allowedLink, deniedLink],
    areaDenies: [root, '/install/private/*'],
    runningInstallRoot: root,
    onWarning: (message) => warnings.push(message),
  })

  expect(carvebacks).toEqual([allowedLink])
  expect(warnings).toEqual([expect.stringContaining(deniedLink)])
})
