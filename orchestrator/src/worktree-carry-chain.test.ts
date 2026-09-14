// Tests run.ts: runJob carry audit inheritance.
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hermeticGitEnv } from '../test/fixtures/git.ts'
import { workerReply } from '../test/fixtures/replies.ts'
import { db } from './db.ts'
import { run as runJob } from './run.ts'
import { changesIn } from './worktree.ts'
import { scriptedTransportSequence } from '../test/fake-transport.ts'
import { runDiffCommand } from './run-diff.ts'


  test('every turn in a three-turn chain declares the inherited carry audit', async () => {
    const makeRepo = () => {
      const repo = mkdtempSync(join(tmpdir(), 'orch-carry-chain-'))
      const git = (...args: string[]) => {
        const p = Bun.spawnSync(['git', ...args], {
          cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
        })
        if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      }
      git('init', '-b', 'main')
      git('config', 'user.email', 'orch-test@example.invalid')
      git('config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, '.gitignore'), '.claude/\n')
      writeFileSync(join(repo, 'kept.txt'), 'base\n')
      git('add', '.gitignore', 'kept.txt')
      git('commit', '-m', 'base')
      return repo
    }
    const dirty = makeRepo()
    const clean = makeRepo()
    const applyRepo = mkdtempSync(join(tmpdir(), 'orch-carry-apply-'))
    const priorDepth = process.env.ORCH_DEPTH
    scriptedTransportSequence(Array.from({ length: 6 }, () => [
      { kind: 'completed' as const, output: JSON.stringify(workerReply()) },
    ])).install()
    process.env.ORCH_DEPTH = '0'

    const chain = async (repo: string) => {
      const first = await runJob({
        job: 'implement', prompt: 'carry audit', cwd: repo, agent: 'grok', carry: true,
      })
      const tree = first.worktree!
      const second = await runJob({
        job: 'implement', prompt: 'turn two', cwd: tree.path,
        resume: {
          parent: first.id, agent: 'grok', session: 'carry-session', turn: 2,
          sessionId: 'orch-test-session', worktree: tree,
        },
      })
      const third = await runJob({
        job: 'implement', prompt: 'turn three', cwd: tree.path,
        resume: {
          parent: first.id, agent: 'grok', session: 'carry-session', turn: 3,
          sessionId: 'orch-test-session', worktree: tree,
        },
      })
      return { ids: [first.id, second.id, third.id], tree }
    }

    try {
      writeFileSync(join(dirty, 'kept.txt'), 'carried tracked\n')
      writeFileSync(join(dirty, 'new.txt'), 'carried untracked\n')
      const dirtyChain = await chain(dirty)
      const dirtyRows = db().query(
        `SELECT carry_happened, carry_base_commit, carry_tracked_paths, carry_untracked_paths,
                route_reason
           FROM run WHERE id IN (?,?,?) ORDER BY turn`,
      ).all(...dirtyChain.ids) as Array<{
        carry_happened: number; carry_base_commit: string
        carry_tracked_paths: string; carry_untracked_paths: string; route_reason: string
      }>
      expect(dirtyRows).toHaveLength(3)
      for (const row of dirtyRows) {
        expect(row.carry_happened).toBe(1)
        expect(row.carry_base_commit).toBe(dirtyChain.tree.base)
        expect(JSON.parse(row.carry_tracked_paths)).toEqual(['kept.txt'])
        expect(JSON.parse(row.carry_untracked_paths)).toEqual(['new.txt'])
      }
      expect(dirtyRows[1]!.route_reason).toContain(
        'repository path retargeting not applied because the turn is already bound to its worktree',
      )
      expect(dirtyRows[2]!.route_reason).toContain(
        'repository path retargeting not applied because the turn is already bound to its worktree',
      )

      let output = ''
      await runDiffCommand(dirtyChain.ids[2]!, { has: () => false }, {
        error: () => {}, write: (value) => { output += value },
        usage: (): never => { throw new Error('usage') }, cleanupRepoRoot: () => dirty,
        changesIn, writesRepo: () => true,
      })
      expect(output.match(/^base: /gm)).toHaveLength(1)
      expect(output).toContain('carry: 1 tracked path(s), 1 untracked path(s)')
      expect(output).toContain('carry tracked: "kept.txt"')
      expect(output).toContain('carry untracked: "new.txt"')
      const cloned = Bun.spawnSync(['git', 'clone', '--quiet', dirty, applyRepo], {
        env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      expect(cloned.exitCode).toBe(0)
      const applies = Bun.spawnSync(['git', 'apply', '--check', '-'], {
        cwd: applyRepo, env: hermeticGitEnv(), stdin: Buffer.from(output), stdout: 'pipe', stderr: 'pipe',
      })
      expect(applies.exitCode).toBe(0)

      const cleanChain = await chain(clean)
      for (const id of cleanChain.ids) {
        let cleanOutput = ''
        await runDiffCommand(id, { has: () => false }, {
          error: () => {}, write: (value) => { cleanOutput += value },
          usage: (): never => { throw new Error('usage') }, cleanupRepoRoot: () => clean,
          changesIn, writesRepo: () => true,
        })
        expect(cleanOutput).toContain(
          'carry: none (0 tracked paths, 0 untracked paths)',
        )
      }
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(dirty, { recursive: true, force: true })
      rmSync(clean, { recursive: true, force: true })
      rmSync(applyRepo, { recursive: true, force: true })
    }
  }, 20_000)
