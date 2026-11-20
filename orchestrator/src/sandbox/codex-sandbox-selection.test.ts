import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { resolveStatePaths, STATE_HOME_ENV } from '../../../shared/state-directory.ts'
import type { Project } from '../project/projects.ts'
import { isAtOrBelow } from './area-read-policy.ts'
import { codexPermissionProfileArgs, codexPermissionProfileInput } from './codex-sandbox.ts'
import { selectReadonlySandbox } from './sandbox.ts'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'codex-sandbox-selection-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true })
})

test('Codex writer profile literally denies existing siblings without denying its own tree', () => {
  const state = temporaryDirectory()
  const projects = temporaryDirectory()
  const ownPath = join(projects, 'own')
  const worktreeRoot = join(ownPath, '.claude/worktrees')
  const worktree = join(worktreeRoot, 'own')
  const siblingA = join(worktreeRoot, 'a')
  const siblingB = join(worktreeRoot, 'b')
  const siblingPath = join(projects, 'sibling')
  mkdirSync(worktree, { recursive: true })
  mkdirSync(siblingA, { recursive: true })
  mkdirSync(siblingB, { recursive: true })
  mkdirSync(siblingPath, { recursive: true })
  const project = (recordId: string, name: string, path: string): Project => ({
    recordId,
    name,
    path,
    stack: 'node',
    canon: true,
    retiredAt: null,
    settings: {},
  })
  const own = project('01990000-0000-7000-8000-000000001214', 'own', ownPath)
  const sibling = project('01990000-0000-7000-8000-000000001215', 'sibling', siblingPath)
  const selected = selectReadonlySandbox({
    agent: 'codex',
    readsRepo: true,
    writesRepo: true,
    worktree,
    runtimeDir: join(state, 'orchestrator/runs/sandbox-run'),
    scratchDir: join(state, 'orchestrator/runs/run/scratch'),
    project: own,
    sharedReader: true,
    registeredProjects: [own, sibling],
    environment: { HOME: homedir(), [STATE_HOME_ENV]: state },
    path: '/usr/bin',
  })
  expect(selected.sandbox).toBe('host')
  expect(selected.profile).toBeNull()
  expect(selected.codexProfile).toBeDefined()

  const permissionInput = codexPermissionProfileInput({
    profile: selected.codexProfile!,
    sandbox: 'workspace-write',
    cwd: worktree,
    writableRoots: [],
    tempDir: '/private/tmp/codex-run',
    writesRepository: true,
  })
  expect(permissionInput.writableRoots).toContain(worktree)
  expect(permissionInput.filesystem.denyRead).toEqual(
    expect.arrayContaining([siblingA, siblingB, siblingPath]),
  )
  expect(permissionInput.filesystem.denyRead.some((denied) => isAtOrBelow(denied, worktree))).toBe(
    false,
  )
  expect(permissionInput.filesystem.denyRead).toContain(projects)
  for (const path of [
    ...permissionInput.filesystem.denyRead,
    ...permissionInput.filesystem.allowRead,
    ...permissionInput.writableRoots,
  ]) {
    expect(path).not.toMatch(/[*?[]/)
  }
  const filesystemArg = codexPermissionProfileArgs({
    ...permissionInput,
    network: false,
  }).find((arg) => arg.startsWith(`permissions.${PLATFORM_SLUG}.filesystem=`))
  expect(filesystemArg).toContain(`${JSON.stringify(siblingPath)}="deny"`)
  expect(filesystemArg).toContain(`${JSON.stringify(siblingA)}="deny"`)
  expect(filesystemArg).toContain(`${JSON.stringify(siblingB)}="deny"`)
  expect(filesystemArg).toContain(
    `${JSON.stringify(resolveStatePaths({ [STATE_HOME_ENV]: state }).root)}="deny"`,
  )
  expect(filesystemArg).toContain(`${JSON.stringify(worktree)}="write"`)
  expect(filesystemArg).toContain(`${JSON.stringify('/tmp')}="write"`)
  expect(filesystemArg).toContain(`${JSON.stringify('/private/tmp/codex-run')}="write"`)
})

test('Codex translation preserves ancestor state denies for a no-repo reader', () => {
  const state = temporaryDirectory()
  const projects = temporaryDirectory()
  const ownPath = join(projects, 'own')
  const runDirectory = join(state, 'orchestrator', 'runs', 'reader-run')
  mkdirSync(ownPath, { recursive: true })
  mkdirSync(runDirectory, { recursive: true })
  const project: Project = {
    recordId: '01990000-0000-7000-8000-000000001216',
    name: 'own',
    path: ownPath,
    stack: 'node',
    canon: true,
    retiredAt: null,
    settings: {},
  }
  const selected = selectReadonlySandbox({
    agent: 'codex',
    readsRepo: false,
    writesRepo: false,
    worktree: runDirectory,
    runtimeDir: runDirectory,
    scratchDir: join(runDirectory, 'scratch'),
    project: null,
    sharedReader: true,
    registeredProjects: [project],
    environment: { HOME: homedir(), [STATE_HOME_ENV]: state },
    path: '/usr/bin',
  })
  const permissionInput = codexPermissionProfileInput({
    profile: selected.codexProfile!,
    sandbox: 'workspace-write',
    cwd: runDirectory,
    writableRoots: [],
    tempDir: join(runDirectory, 'tmp'),
    writesRepository: false,
  })
  const statePaths = resolveStatePaths({ [STATE_HOME_ENV]: state })
  expect(permissionInput.filesystem.denyRead).toEqual(
    expect.arrayContaining([statePaths.root, statePaths.orchestratorRuns]),
  )
})
