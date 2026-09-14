import { describe,expect,test } from 'bun:test'
import { mkdtempSync,rmSync,writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { AGENTS } from '../../src/agents.ts'
import { db } from '../../src/db.ts'
import { upsertProject } from '../../src/projects.ts'
import { run as runJob } from '../../src/run.ts'
import { hermeticGitEnv } from '../fixtures/git.ts'
import { reviewReply } from '../fixtures/replies.ts'

import { stubWorker } from '../stub-worker.ts'
import { trackedTestResidue } from '../residue.ts'
const trackResidue = trackedTestResidue()
const worker = () => { const script = stubWorker(); trackResidue(dirname(script)); return script }

describe('review-lens-inline has no checkout', () => {
test('explicit review records the trunk merge-base for clean-review evidence', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-explicit-review-evidence-'))
    const script = worker()
    const agent = AGENTS.codex!
    const original = {
      bin: agent.bin, argv: agent.argv, stdin: agent.stdin,
      readsOut: agent.readsOut, parseReply: agent.parseReply,
    }
    const oldDepth = process.env.ORCH_DEPTH
    const oldOutput = process.env.ORCH_STUB_OUTPUT
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    const report = (covered: string) => {
      const reply = reviewReply(0)
      reply.provenance.files_covered = [covered]
      reply.provenance.commands_run = [`git diff main...feature/evidence -- ${covered}`]
      process.env.ORCH_STUB_OUTPUT = JSON.stringify(reply)
      return reply
    }
    try {
      git('init', '-b', 'main')
      git('config', 'user.email', 'orch-test@example.invalid')
      git('config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, 'untouched.txt'), 'base\n')
      git('add', '.')
      git('commit', '-m', 'fixture trunk')
      git('switch', '-c', 'feature/evidence')
      writeFileSync(join(repo, 'changed.txt'), 'first\n')
      git('add', '.')
      git('commit', '-m', 'first branch commit')
      writeFileSync(join(repo, 'second.txt'), 'second\n')
      git('add', '.')
      git('commit', '-m', 'second branch commit')
      git('switch', 'main')
      writeFileSync(join(repo, 'trunk-only.txt'), 'unrelated trunk move\n')
      git('add', 'trunk-only.txt')
      git('commit', '-m', 'move trunk independently')
      const base = git('rev-parse', 'HEAD^{commit}')
      git('switch', 'feature/evidence')
      git('rebase', 'main')
      const tip = git('rev-parse', 'HEAD^{commit}')
      const tree = git('rev-parse', 'HEAD^{tree}')
      git('switch', 'main')
      upsertProject({
        name: 'explicit-review-evidence-fixture', path: repo, settings: { trunk: 'main' },
      })
      agent.bin = script
      agent.argv = () => []
      agent.stdin = false
      agent.readsOut = false
      agent.parseReply = undefined
      process.env.ORCH_DEPTH = '0'

      report('changed.txt:1-2 — inspected changed behavior')
      const clean = await runJob({
        job: 'review-lens', prompt: 'inspect', cwd: repo, agent: 'codex',
        lens: 'explicit-evidence-clean', review: 'feature/evidence', keepTree: true,
      })
      expect(db().query(
        'SELECT base_commit, input_tree, head_commit, review_ref, changed_paths FROM run WHERE id=?',
      ).get(clean.id)).toEqual({
        base_commit: base, input_tree: tree, head_commit: tip, review_ref: 'feature/evidence',
        changed_paths: JSON.stringify(['changed.txt', 'second.txt']),
      })
      const recorded = (db().query('SELECT review_id FROM review_lens WHERE run_id=?').get(clean.id) as
        { review_id: number }).review_id
      expect(db().query('SELECT files_covered FROM review_lens WHERE review_id=?').get(recorded))
        .toEqual({ files_covered: JSON.stringify(['changed.txt']) })

      report('untouched.txt')
      await expect(runJob({
        job: 'review-lens', prompt: 'inspect', cwd: repo, agent: 'codex',
        lens: 'explicit-evidence-untouched', review: 'feature/evidence', noFailover: true,
      })).rejects.toThrow(
        'clean review with no evidence: files_covered intersects none of the changed paths',
      )

      report('untouched.txt')
      let emptyRunId: number | undefined
      try {
        await runJob({
          job: 'review-lens', prompt: 'inspect', cwd: repo, agent: 'codex',
          lens: 'explicit-evidence-empty', review: 'main', noFailover: true,
        })
      } catch (cause) {
        emptyRunId = (cause as Error & { runId?: number }).runId
      }
      expect(emptyRunId).toBeNumber()
      expect(db().query('SELECT changed_paths FROM run WHERE id=?').get(emptyRunId!))
        .toEqual({ changed_paths: '[]' })
      expect(db().query('SELECT status, failure_kind, error FROM run WHERE id=?').get(emptyRunId!))
        .toEqual({
          status: 'failed', failure_kind: 'harness',
          error: expect.stringContaining('changed-path set is empty'),
        })
      expect(db().query('SELECT id FROM review_lens WHERE run_id=?').get(emptyRunId!)).toBeNull()
      const scored = Bun.spawnSync([
        process.execPath, new URL('../../src/orch.ts', import.meta.url).pathname,
        'score', String(emptyRunId), 'full', 'right', '--force',
      ], {
        env: {
          ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
          CLAUDE_CODE_SESSION_ID: 'orch-test-session',
        },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(scored.exitCode).toBe(1)
      expect(scored.stderr.toString()).toContain('harness')
      expect(db().query('SELECT id FROM score WHERE run_id=?').get(emptyRunId!)).toBeNull()
    } finally {
      agent.bin = original.bin
      agent.argv = original.argv
      agent.stdin = original.stdin
      agent.readsOut = original.readsOut
      agent.parseReply = original.parseReply
      if (oldDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = oldDepth
      if (oldOutput === undefined) delete process.env.ORCH_STUB_OUTPUT
      else process.env.ORCH_STUB_OUTPUT = oldOutput
      rmSync(repo, { recursive: true, force: true })
    }
  })
test('implicit review measures from the constructed trunk merge-base', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-implicit-review-evidence-'))
    const script = worker()
    const agent = AGENTS.codex!
    const original = {
      bin: agent.bin, argv: agent.argv, stdin: agent.stdin,
      readsOut: agent.readsOut, parseReply: agent.parseReply,
    }
    const oldDepth = process.env.ORCH_DEPTH
    const oldOutput = process.env.ORCH_STUB_OUTPUT
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    const report = (covered: string) => {
      const reply = reviewReply(0)
      reply.provenance.files_covered = [covered]
      reply.provenance.commands_run = [`git diff develop...HEAD -- ${covered}`]
      process.env.ORCH_STUB_OUTPUT = JSON.stringify(reply)
      return reply
    }
    try {
      git('init', '-b', 'develop')
      git('config', 'user.email', 'orch-test@example.invalid')
      git('config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, 'untouched.txt'), 'base\n')
      git('add', '.')
      git('commit', '-m', 'fixture trunk')
      git('switch', '-c', 'feature/implicit')
      writeFileSync(join(repo, 'changed.txt'), 'branch change\n')
      git('add', '.')
      git('commit', '-m', 'branch change')
      git('switch', 'develop')
      writeFileSync(join(repo, 'trunk-only.txt'), 'unrelated trunk move\n')
      git('add', 'trunk-only.txt')
      git('commit', '-m', 'move trunk independently')
      git('switch', 'feature/implicit')
      const mergeBase = git('merge-base', 'HEAD', 'develop')
      const tip = git('rev-parse', 'HEAD^{commit}')
      expect(mergeBase).not.toBe(tip)
      upsertProject({
        name: 'implicit-review-evidence-fixture', path: repo, settings: { trunk: 'develop' },
      })
      agent.bin = script
      agent.argv = () => []
      agent.stdin = false
      agent.readsOut = false
      agent.parseReply = undefined
      process.env.ORCH_DEPTH = '0'

      report('changed.txt:1-2 — inspected changed behavior')
      const clean = await runJob({
        job: 'review-lens', prompt: 'inspect', cwd: repo, agent: 'codex',
        lens: 'implicit-evidence-clean', keepTree: true,
      })
      expect(db().query(
        'SELECT base_commit, head_commit, review_ref FROM run WHERE id=?',
      ).get(clean.id)).toEqual({
        base_commit: mergeBase, head_commit: tip, review_ref: null,
      })
      expect(db().query('SELECT review_id FROM review_lens WHERE run_id=?').get(clean.id)).not.toBeNull()

      report('untouched.txt')
      await expect(runJob({
        job: 'review-lens', prompt: 'inspect', cwd: repo, agent: 'codex',
        lens: 'implicit-evidence-untouched', noFailover: true,
      })).rejects.toThrow(
        'clean review with no evidence: files_covered intersects none of the changed paths',
      )

      report('trunk-only.txt')
      let trapRunId: number | undefined
      try {
        await runJob({
          job: 'review-lens', prompt: 'inspect', cwd: repo, agent: 'codex',
          lens: 'implicit-evidence-trunk-only', noFailover: true,
        })
      } catch (cause) {
        trapRunId = (cause as Error & { runId?: number }).runId
      }
      expect(trapRunId).toBeNumber()
      expect(db().query('SELECT failure_kind FROM run WHERE id=?').get(trapRunId!))
        .toEqual({ failure_kind: 'unevidenced' })
    } finally {
      agent.bin = original.bin
      agent.argv = original.argv
      agent.stdin = original.stdin
      agent.readsOut = original.readsOut
      agent.parseReply = original.parseReply
      if (oldDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = oldDepth
      if (oldOutput === undefined) delete process.env.ORCH_STUB_OUTPUT
      else process.env.ORCH_STUB_OUTPUT = oldOutput
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
