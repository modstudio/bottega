import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from '../git/git-environment.ts'
import { installWorkerHooks } from './worker-hooks.ts'

const refusal = 'workers never push; the architect pushes after review'

test('worker pre-push allows only pushes between local scratch repositories', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-worker-pre-push-'))
  try {
    const hooks = join(root, 'hooks')
    const source = join(root, 'source')
    const destination = join(root, 'destination.git')
    const guarded = join(root, 'guarded.git')
    mkdirSync(hooks)
    mkdirSync(source)
    mkdirSync(destination)
    mkdirSync(guarded)
    installWorkerHooks(hooks)
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

    const hook = join(hooks, 'pre-push')
    const environment = {
      ...process.env,
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

    expect(push(source, destination).exitCode).toBe(0)

    const fromGuarded = invoke(guarded, destination)
    expect(fromGuarded.exitCode).not.toBe(0)
    expect(fromGuarded.stderr.toString()).toContain(refusal)
    expect(fromGuarded.stderr.toString()).toContain('push originates from the guarded repository')

    const intoGuarded = push(source, guarded)
    expect(intoGuarded.exitCode).not.toBe(0)
    expect(intoGuarded.stderr.toString()).toContain(refusal)
    expect(intoGuarded.stderr.toString()).toContain('push targets the guarded repository')

    for (const target of ['https://example.invalid/repository.git', 'host:repository.git']) {
      const result = invoke(source, target)
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.toString()).toContain(refusal)
      expect(result.stderr.toString()).toContain('destination is not a local directory')
    }

    const outsideScratch = invoke(source, process.cwd(), {
      ...environment,
      TMPDIR: process.cwd(),
      ORCH_SCRATCH: process.cwd(),
    })
    expect(outsideScratch.exitCode).not.toBe(0)
    expect(outsideScratch.stderr.toString()).toContain(refusal)
    expect(outsideScratch.stderr.toString()).toContain(
      'destination is not a local scratch repository',
    )

    const { ORCH_GUARDED_GIT_COMMON_DIR: _guard, ...withoutGuard } = environment
    const guardUnset = invoke(source, destination, withoutGuard)
    expect(guardUnset.exitCode).not.toBe(0)
    expect(guardUnset.stderr.toString()).toContain(refusal)
    expect(guardUnset.stderr.toString()).toContain('guarded repository is not named')

    const sourceOutsideScratch = invoke(process.cwd(), destination)
    expect(sourceOutsideScratch.exitCode).not.toBe(0)
    expect(sourceOutsideScratch.stderr.toString()).toContain(refusal)
    expect(sourceOutsideScratch.stderr.toString()).toContain(
      'pushing repository is not a local scratch repository',
    )

    expect(readFileSync(hook, 'utf8')).toContain(refusal)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
