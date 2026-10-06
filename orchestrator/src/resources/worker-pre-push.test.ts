import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git, gitOk } from '../git/git-environment.ts'
import { installWorkerHooks } from './worker-hooks.ts'

const refusal = 'workers never push; the architect pushes after review'

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'orch-worker-pre-push-'))
  const scratch = join(root, 'scratch')
  const outside = join(root, 'outside')
  const hooks = join(scratch, 'hooks')
  const source = join(scratch, 'source')
  const destination = join(scratch, 'destination.git')
  const guarded = join(scratch, 'guarded.git')
  const linkedDestination = join(scratch, 'linked-destination')
  const linkedSource = join(scratch, 'linked-source')
  const outsideCommon = join(outside, 'outside.git')
  mkdirSync(scratch)
  mkdirSync(outside)
  mkdirSync(hooks)
  mkdirSync(source)
  mkdirSync(destination)
  mkdirSync(guarded)
  mkdirSync(linkedDestination)
  installWorkerHooks(hooks, [scratch])
  git(['init', '--initial-branch=main'], source)
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
    source,
  )
  git(['init', '--bare'], destination)
  git(['init', '--bare'], guarded)
  git(['clone', '--bare', source, outsideCommon], outside)
  git(['--git-dir', outsideCommon, 'worktree', 'add', '--detach', linkedSource], outside)
  writeFileSync(join(linkedDestination, '.git'), `gitdir: ${outsideCommon}\n`)

  const hook = join(hooks, 'pre-push')
  const environment = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: root,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: hooks,
    ORCH_GUARDED_GIT_COMMON_DIR: realpathSync(guarded),
  }
  const push = (cwd: string, target: string, env: NodeJS.ProcessEnv = environment) =>
    Bun.spawnSync(['git', 'push', target, 'HEAD:refs/heads/pushed'], {
      cwd,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
  const invoke = (cwd: string, target: string, env: NodeJS.ProcessEnv = environment) =>
    Bun.spawnSync([hook, 'origin', target], {
      cwd,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
  return {
    root,
    outside,
    source,
    destination,
    guarded,
    linkedDestination,
    linkedSource,
    outsideCommon,
    hook,
    environment,
    push,
    invoke,
  }
}

let fixture: ReturnType<typeof createFixture>
beforeAll(() => {
  fixture = createFixture()
})
afterAll(() => {
  rmSync(fixture.root, { recursive: true, force: true })
})

test('worker pre-push allows scratch pushes but refuses the guarded repository', () => {
  expect(fixture.push(fixture.source, fixture.destination).exitCode).toBe(0)

  const fromGuarded = fixture.invoke(fixture.guarded, fixture.destination)
  expect(fromGuarded.exitCode).not.toBe(0)
  expect(fromGuarded.stderr.toString()).toContain(refusal)
  expect(fromGuarded.stderr.toString()).toContain('push originates from the guarded repository')

  const intoGuarded = fixture.push(fixture.source, fixture.guarded)
  expect(intoGuarded.exitCode).not.toBe(0)
  expect(intoGuarded.stderr.toString()).toContain(refusal)
  expect(intoGuarded.stderr.toString()).toContain('push targets the guarded repository')
  expect(readFileSync(fixture.hook, 'utf8')).toContain(refusal)
})

test('worker pre-push refuses non-local, outside-scratch, and unguarded invocations', () => {
  for (const target of ['https://example.invalid/repository.git', 'host:repository.git']) {
    const result = fixture.invoke(fixture.source, target)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain(refusal)
    expect(result.stderr.toString()).toContain('destination is not a local directory')
  }

  const outsideScratch = fixture.invoke(fixture.source, fixture.outside)
  expect(outsideScratch.exitCode).not.toBe(0)
  expect(outsideScratch.stderr.toString()).toContain(refusal)
  expect(outsideScratch.stderr.toString()).toContain(
    'destination is not a local scratch repository',
  )

  const { ORCH_GUARDED_GIT_COMMON_DIR: _guard, ...withoutGuard } = fixture.environment
  const guardUnset = fixture.invoke(fixture.source, fixture.destination, withoutGuard)
  expect(guardUnset.exitCode).not.toBe(0)
  expect(guardUnset.stderr.toString()).toContain(refusal)
  expect(guardUnset.stderr.toString()).toContain('guarded repository is not named')

  const sourceOutsideScratch = fixture.invoke(fixture.outsideCommon, fixture.destination)
  expect(sourceOutsideScratch.exitCode).not.toBe(0)
  expect(sourceOutsideScratch.stderr.toString()).toContain(refusal)
  expect(sourceOutsideScratch.stderr.toString()).toContain(
    'pushing repository is not a local scratch repository',
  )
})

test('worker pre-push refuses scratch paths whose common directories are outside scratch', () => {
  const redirectedDestination = fixture.push(fixture.source, fixture.linkedDestination)
  expect(redirectedDestination.exitCode).not.toBe(0)
  expect(redirectedDestination.stderr.toString()).toContain(refusal)
  expect(redirectedDestination.stderr.toString()).toContain(
    'destination common directory is not under a scratch location',
  )
  expect(gitOk(['show-ref', '--verify', 'refs/heads/pushed'], fixture.outsideCommon)).toBeNull()

  const redirectedSource = fixture.invoke(fixture.linkedSource, fixture.destination)
  expect(redirectedSource.exitCode).not.toBe(0)
  expect(redirectedSource.stderr.toString()).toContain(refusal)
  expect(redirectedSource.stderr.toString()).toContain(
    'pushing repository common directory is not under a scratch location',
  )
})
