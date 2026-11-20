import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { resolveStatePaths, STATE_HOME_ENV } from '../../../shared/state-directory.ts'
import type { Project } from '../project/projects.ts'
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

test('Codex selection carries planted area denies through the shared mapping into permission argv', () => {
  const state = temporaryDirectory()
  const projects = temporaryDirectory()
  const ownPath = join(projects, 'own')
  const worktree = join(ownPath, '.claude/worktrees/run')
  const siblingPath = join(projects, 'sibling')
  mkdirSync(worktree, { recursive: true })
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
    writesRepo: false,
    worktree,
    runtimeDir: join(state, 'orchestrator/runs/sandbox-run'),
    scratchDir: join(state, 'orchestrator/runs/run/scratch'),
    project: own,
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
    writableRoots: selected.codexProfile!.filesystem.allowWrite,
    tempDir: '/private/tmp/codex-run',
    repository: true,
  })
  const filesystemArg = codexPermissionProfileArgs({
    ...permissionInput,
    network: false,
  }).find((arg) => arg.startsWith(`permissions.${PLATFORM_SLUG}.filesystem=`))
  expect(filesystemArg).toContain(`${JSON.stringify(siblingPath)}="deny"`)
  expect(filesystemArg).toContain(
    `${JSON.stringify(resolveStatePaths({ [STATE_HOME_ENV]: state }).root)}="deny"`,
  )
  expect(filesystemArg).toContain(`${JSON.stringify(worktree)}="write"`)
})
