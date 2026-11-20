import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBoundedSync } from '../../shared/bounded-process.ts'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { targetGitEnvironment, worktreeGitDir } from '../src/git/git-environment.ts'
import type { Project } from '../src/project/projects.ts'
import { workerSharedGitRoots } from '../src/resources/ref-guard.ts'
import { codexPermissionLaunchProfileInput } from '../src/sandbox/codex-permission-profile-adapter.ts'
import { codexPermissionProfileArgs } from '../src/sandbox/codex-sandbox.ts'
import { codexPermissionProfile } from '../src/sandbox/sandbox.ts'

function run(argv: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const result = startBoundedSync(argv, { budget: 'sandbox-probe', cwd, env })
  if (result.exitCode !== 0) {
    throw new Error(`${argv.join(' ')} exited ${result.exitCode}\n${result.stdout}${result.stderr}`)
  }
  return result.stdout
}

function assertSandboxRefusal(
  permissionArgs: string[],
  command: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): void {
  const result = startBoundedSync(
    ['codex', 'sandbox', '-P', PLATFORM_SLUG, ...permissionArgs, '--', ...command],
    { budget: 'sandbox-probe', cwd, env },
  )
  const output = `${result.stdout}${result.stderr}`
  if (result.exitCode === 0) throw new Error(`${command.join(' ')} unexpectedly succeeded`)
  if (!output.includes('packed-refs.lock') || !output.includes('Operation not permitted')) {
    throw new Error(
      `${command.join(' ')} exited ${result.exitCode} without the expected sandbox refusal\n${output}`,
    )
  }
}

function project(recordId: string, name: string, path: string): Project {
  return {
    recordId,
    name,
    path,
    stack: 'canary',
    canon: false,
    retiredAt: null,
    settings: {},
  }
}

const root = mkdtempSync(join(tmpdir(), 'codex-permission-canary-'))
try {
  const projects = join(root, 'projects')
  const main = join(projects, 'proj')
  const other = join(projects, 'other')
  const worktrees = join(main, '.claude', 'worktrees')
  const own = join(worktrees, 'own')
  const sibling = join(worktrees, 'sibling')
  const scratch = join(root, 'scratch')
  const runtime = join(root, 'runtime')
  const state = join(root, 'state')
  mkdirSync(other, { recursive: true })
  mkdirSync(scratch)
  mkdirSync(runtime)
  mkdirSync(state)
  mkdirSync(join(state, 'hub'))
  writeFileSync(join(other, 'secret.txt'), 'other project\n')
  mkdirSync(main)
  const gitEnvironment = targetGitEnvironment(main)
  run(['git', 'init', '-q', '-b', 'main'], main, gitEnvironment)
  run(['git', 'config', 'user.email', 'canary@example.invalid'], main, gitEnvironment)
  run(['git', 'config', 'user.name', 'Codex Canary'], main, gitEnvironment)
  writeFileSync(join(main, 'README'), 'fixture\n')
  run(['git', 'add', 'README'], main, gitEnvironment)
  run(['git', 'commit', '-qm', 'initial'], main, gitEnvironment)
  run(['git', 'worktree', 'add', '-q', '-b', 'own', own], main, gitEnvironment)
  run(['git', 'worktree', 'add', '-q', '-b', 'sibling', sibling], main, gitEnvironment)
  writeFileSync(join(sibling, 'sibling-secret.txt'), 'sibling\n')

  const ownProject = project('own-project', 'own-project', main)
  const otherProject = project('other-project', 'other-project', other)
  const environment = {
    ...process.env,
    BOTTEGA_STATE_HOME: state,
    BOTTEGA_HUB_DB: join(state, 'hub', 'hub.db'),
  }
  const sharedProfile = codexPermissionProfile({
    worktree: own,
    runtimeDir: runtime,
    scratchDir: scratch,
    project: ownProject,
    registeredProjects: [ownProject, otherProject],
    agent: 'codex',
    environment,
    allowWrite: [own, runtime, scratch],
    socketDenyPaths: [],
  })
  const writableRoots = [scratch, worktreeGitDir(own), ...workerSharedGitRoots(own, 'own')]
  const permissionArgs = codexPermissionProfileArgs({
    ...codexPermissionLaunchProfileInput({
      profile: sharedProfile,
      sandbox: 'workspace-write',
      cwd: own,
      writableRoots,
      tempDir: runtime,
      writesRepository: true,
    }),
    network: false,
  })
  const script = [
    'set -eu',
    'pwd',
    'git status --short',
    'printf canary > canary.txt',
    'git add canary.txt',
    'git commit -qm canary',
    'git log --format=%s -1 | grep -Fx canary',
    'git branch canary-delete',
    `if cat ${JSON.stringify(join(sibling, 'sibling-secret.txt'))} >/dev/null 2>&1; then exit 41; fi`,
    `if cat ${JSON.stringify(join(other, 'secret.txt'))} >/dev/null 2>&1; then exit 42; fi`,
  ].join('\n')
  const sandboxEnvironment = {
    ...environment,
    ...gitEnvironment,
    GIT_AUTHOR_NAME: 'Codex Canary',
    GIT_AUTHOR_EMAIL: 'canary@example.invalid',
    GIT_COMMITTER_NAME: 'Codex Canary',
    GIT_COMMITTER_EMAIL: 'canary@example.invalid',
  }
  const output = run(
    ['codex', 'sandbox', '-P', PLATFORM_SLUG, ...permissionArgs, '--', '/bin/sh', '-c', script],
    own,
    sandboxEnvironment,
  )
  if (!output.includes('canary')) throw new Error('Codex canary commit was absent from git log')
  assertSandboxRefusal(
    permissionArgs,
    ['git', 'branch', '-d', 'canary-delete'],
    own,
    sandboxEnvironment,
  )
  assertSandboxRefusal(permissionArgs, ['git', 'pack-refs', '--all'], own, sandboxEnvironment)
  console.log(
    'Codex permission canary passed: commits succeeded, packed-refs mutations and sibling reads were denied',
  )
} finally {
  rmSync(root, { recursive: true, force: true })
}
