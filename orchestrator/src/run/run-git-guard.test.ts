import { expect, test } from 'bun:test'
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git, gitOk } from '../git/git-environment.ts'
import { workerGitConfigEnvironment } from './run-git-guard.ts'

test('reader launch installs and selects an unconditional worker pre-push guard', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'orch-reader-guard-main-'))
  const path = join(repoRoot, '.claude', 'worktrees', 'orch-832')
  try {
    git(['init', '--initial-branch=main'], repoRoot)
    git(
      [
        '-c',
        'user.name=Orch Test',
        '-c',
        'user.email=orch@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        'initial',
      ],
      repoRoot,
    )
    git(['clone', '--shared', repoRoot, path], repoRoot)
    git(['remote', 'remove', 'origin'], path)
    writeFileSync(join(path, '.orch-run'), `832\n${repoRoot}\nsource: clone\n`)

    const environment = workerGitConfigEnvironment(
      { path, branch: '', base: 'HEAD', repoRoot, source: 'clone' },
      false,
      'review',
    )

    expect(environment?.GIT_CONFIG_KEY_0).toBe('core.hooksPath')
    const prePush = join(environment!.GIT_CONFIG_VALUE_0, 'pre-push')
    accessSync(prePush, constants.X_OK)
    expect(readFileSync(prePush, 'utf8')).toContain(
      'workers never push; the architect pushes after review',
    )
    const hook = Bun.spawnSync([prePush], { stdout: 'pipe', stderr: 'pipe' })
    expect(hook.exitCode).not.toBe(0)
    expect(hook.stderr.toString().trim()).toBe(
      'workers never push; the architect pushes after review',
    )
    const push = Bun.spawnSync(['git', 'push', repoRoot, 'HEAD:refs/heads/x'], {
      cwd: path,
      env: { ...process.env, ...environment },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(push.exitCode).not.toBe(0)
    expect(push.stderr.toString()).toContain(
      'workers never push; the architect pushes after review',
    )
    expect(gitOk(['show-ref', '--verify', 'refs/heads/x'], repoRoot)).toBeNull()
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('writer launch refuses pushes and attributed commits without enforcing task keys', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'orch-writer-guard-main-'))
  const path = join(repoRoot, '.claude', 'worktrees', 'orch-939')
  try {
    git(['init', '--initial-branch=main'], repoRoot)
    git(
      [
        '-c',
        'user.name=Orch Test',
        '-c',
        'user.email=orch@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        'initial',
      ],
      repoRoot,
    )
    git(['worktree', 'add', '-b', 'DEV-939-writer', path], repoRoot)
    writeFileSync(join(path, '.orch-run'), `939\n${repoRoot}\nsource: worktree\n`)

    const environment = workerGitConfigEnvironment(
      { path, branch: 'DEV-939-writer', base: 'HEAD', repoRoot, source: 'git' },
      true,
      'implement',
    )!
    const workerEnv = { ...process.env, ...environment }
    const push = Bun.spawnSync(['git', 'push', repoRoot, 'HEAD:refs/heads/pushed'], {
      cwd: path,
      env: workerEnv,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(push.exitCode).not.toBe(0)
    expect(push.stderr.toString()).toContain(
      'workers never push; the architect pushes after review',
    )
    expect(gitOk(['show-ref', '--verify', 'refs/heads/pushed'], repoRoot)).toBeNull()

    const clean = Bun.spawnSync(
      [
        'git',
        '-c',
        'user.name=Orch Test',
        '-c',
        'user.email=orch@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        'message without a project task key',
      ],
      { cwd: path, env: workerEnv, stdout: 'pipe', stderr: 'pipe' },
    )
    expect(clean.exitCode).toBe(0)

    const attributed = Bun.spawnSync(
      [
        'git',
        '-c',
        'user.name=Orch Test',
        '-c',
        'user.email=orch@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        'Co-authored-by: Claude <bot@anthropic.com>',
      ],
      { cwd: path, env: workerEnv, stdout: 'pipe', stderr: 'pipe' },
    )
    expect(attributed.exitCode).not.toBe(0)
    expect(attributed.stderr.toString()).toContain('AI attribution is not allowed')
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})
