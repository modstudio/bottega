import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hermeticGitEnv } from '../fixtures/git.ts'

describe('git environment process boundary', () => {
test('an operational git refuses when the local-env query fails and cannot delete in an inherited repository', () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-local-env-refusal-'))
    const repoA = join(root, 'repo-a')
    const repoB = join(root, 'repo-b')
    const bin = join(root, 'bin')
    mkdirSync(repoA)
    mkdirSync(repoB)
    mkdirSync(bin)
    const realGit = Bun.which('git')!
    const fixtureGit = (repo: string, ...args: string[]) => {
      const p = Bun.spawnSync([realGit, ...args], { cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    try {
      for (const repo of [repoA, repoB]) {
        fixtureGit(repo, 'init', '-b', 'main')
        fixtureGit(repo, 'config', 'user.email', 'orch-test@example.invalid')
        fixtureGit(repo, 'config', 'user.name', 'Orch Test')
        writeFileSync(join(repo, 'tracked'), 'fixture\n')
        fixtureGit(repo, 'add', 'tracked')
        fixtureGit(repo, 'commit', '-m', 'fixture')
        fixtureGit(repo, 'branch', 'same-name')
      }
      const wrapper = join(bin, 'git')
      writeFileSync(wrapper, `#!/bin/sh\nif [ "$1 $2" = "rev-parse --local-env-vars" ]; then\n  echo rejected >&2\n  exit 129\nfi\nexec ${JSON.stringify(realGit)} "$@"\n`)
      chmodSync(wrapper, 0o755)
      const child = Bun.spawnSync([process.execPath, '--eval', `
        const { targetGitEnvironment } = await import(${JSON.stringify(new URL('../../src/git-environment.ts', import.meta.url).href)});
        const { inspectCheckout } = await import(${JSON.stringify(new URL('../../../shared/git.ts', import.meta.url).href)});
        const inspection = inspectCheckout(${JSON.stringify(repoA)});
        try {
          const env = targetGitEnvironment(${JSON.stringify(repoA)});
          const result = Bun.spawnSync(['git', '-C', ${JSON.stringify(repoA)}, 'branch', '-D', 'same-name'], { env, stdout: 'pipe', stderr: 'pipe' });
          process.stdout.write(JSON.stringify({ refused: false, inspection, code: result.exitCode, stderr: result.stderr.toString() }));
        } catch (error) {
          process.stdout.write(JSON.stringify({ refused: true, inspection, error: String(error) }));
        }
      `], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, GIT_DIR: join(repoB, '.git') },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(child.exitCode, child.stderr.toString()).toBe(0)
      const answer = JSON.parse(child.stdout.toString()) as { refused: boolean; inspection: { cleanliness: string }; error?: string }
      expect(answer.refused).toBe(true)
      expect(answer.inspection.cleanliness).toBe('indeterminate')
      expect(answer.error).toContain('git rev-parse --local-env-vars failed with exit 129: rejected')
      expect(fixtureGit(repoA, 'branch', '--list', 'same-name')).toContain('same-name')
      expect(fixtureGit(repoB, 'branch', '--list', 'same-name')).toContain('same-name')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

})
