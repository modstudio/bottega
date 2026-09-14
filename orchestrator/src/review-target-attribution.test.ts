import { describe,expect,test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync,mkdtempSync,rmSync,writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hermeticGitEnv } from '../test/fixtures/git.ts'
import { db } from './db.ts'
import { preflight } from './dispatch-preflight.ts'
import { projectAt, upsertProject } from './projects.ts'
import { inferredReadOnlyKey } from './review-target.ts'
import { run as runJob } from './run.ts'
import { scriptedTransport } from '../test/fake-transport.ts'

describe('read-only run task attribution', () => {
const git = (cwd: string, ...args: string[]) => {
    const p = Bun.spawnSync(['git', ...args], {
      cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    return p.stdout.toString().trim()
  }
const repository = (branch = 'main') => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-attribution-'))
    git(repo, 'init', '-b', branch)
    git(repo, 'config', 'user.email', 'orch-test@example.invalid')
    git(repo, 'config', 'user.name', 'Orch Test')
    writeFileSync(join(repo, 'tracked.txt'), 'fixture\n')
    git(repo, 'add', 'tracked.txt')
    git(repo, 'commit', '-m', 'fixture')
    upsertProject({
      name: `attribution-${randomUUID()}`, path: repo,
      settings: { keyPrefixes: ['DEV'] },
    })
    return repo
  }
const launch = async (cwd: string, key?: string) => {
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      scriptedTransport([{ kind: 'completed', output: 'attributed' }]).install()
      const result = await runJob({
        job: 'file-question', prompt: 'inspect', cwd, key, agent: 'codex', noFailover: true,
      })
      return (db().query('SELECT launch_key FROM run WHERE id=?').get(result.id) as
        { launch_key: string | null }).launch_key
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  }
test('records the key carried by the caller worktree name before the branch key', async () => {
    const repo = repository()
    const worktree = join(repo, '.claude', 'worktrees', 'DEV-204-context')
    mkdirSync(join(repo, '.claude', 'worktrees'), { recursive: true })
    git(repo, 'worktree', 'add', '-b', 'feature/DEV-205-branch', worktree)
    try {
      expect(inferredReadOnlyKey(worktree)).toBe('DEV-204')
      expect(await launch(worktree)).toBe('DEV-204')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })
test('records the branch key when the checkout name carries none', async () => {
    const repo = repository('feature/DEV-205-branch')
    try {
      expect(inferredReadOnlyKey(repo)).toBe('DEV-205')
      expect(await launch(repo)).toBe('DEV-205')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })
test('an explicit key wins over worktree and branch inference', async () => {
    const repo = repository()
    const worktree = join(repo, '.claude', 'worktrees', 'DEV-204-context')
    mkdirSync(join(repo, '.claude', 'worktrees'), { recursive: true })
    git(repo, 'worktree', 'add', '-b', 'feature/DEV-205-branch', worktree)
    try { expect(await launch(worktree, 'DEV-206')).toBe('DEV-206') }
    finally { rmSync(repo, { recursive: true, force: true }) }
  })
test('a read-only run with no inferable key launches and records null', async () => {
    const repo = repository()
    try {
      expect(inferredReadOnlyKey(repo)).toBeNull()
      expect(await launch(repo)).toBeNull()
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })
test('an inferred attribution key never satisfies a writing-run branch requirement', () => {
    const repo = repository()
    const worktree = join(repo, '.claude', 'worktrees', 'DEV-204-context')
    mkdirSync(join(repo, '.claude', 'worktrees'), { recursive: true })
    git(repo, 'worktree', 'add', '-b', 'feature/no-key', worktree)
    const project = projectAt(repo)!
    upsertProject({
      name: project.name, path: repo,
      settings: { keyPrefixes: ['DEV'], worktree: { branch: '{key}-orch-{id}' } },
    })
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      expect(inferredReadOnlyKey(worktree)).toBe('DEV-204')
      expect(() => preflight('implement', worktree)).toThrow('--key <KEY-123>')
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
