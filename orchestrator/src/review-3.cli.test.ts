import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { landingReviewCoverage, AGENTS, MIN_SAMPLE, addRun, completeReview, contentTree, coverageAudit, db, dir, evidenceFor, guide, hermeticGitEnv, implicitReviewWarning, noRepoIsolatePath, pick, recordReview, resolveReviewTarget, reviewReply, runJob, score, upsertProject } from '../test/fixture.ts'

describe('review-lens-inline has no checkout', () => {
  test('the no-repo isolate is deterministically named below an owned runs directory', () => {
    const ownedRuns = '/var/lib/orch/runs'
    expect(noRepoIsolatePath(42, ownedRuns)).toBe('/var/lib/orch/runs/isolates/42')
    expect(noRepoIsolatePath(42, ownedRuns).startsWith(tmpdir())).toBe(false)
  })

  test('summarize runs under srt from an unregistered directory', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'orch-unregistered-summary-'))
    const script = join(dir, 'unregistered-summary-worker.ts')
    writeFileSync(script, `console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'summary from anywhere' }))\n`)
    const agent = AGENTS.grok!
    const original = { bin: agent.bin, argv: agent.argv }
    const oldSandbox = process.env.ORCH_SANDBOX
    const oldDepth = process.env.ORCH_DEPTH
    try {
      agent.bin = process.execPath
      agent.argv = () => [script]
      delete process.env.ORCH_SANDBOX
      process.env.ORCH_DEPTH = '0'
      const result = await runJob({
        job: 'summarize', prompt: 'summarize inline context', cwd,
        agent: 'grok', noFailover: true,
      })
      expect(result.output).toBe('summary from anywhere')
      expect(db().query('SELECT sandbox FROM run WHERE id=?').get(result.id))
        .toEqual({ sandbox: 'srt' })
    } finally {
      agent.bin = original.bin
      agent.argv = original.argv
      if (oldSandbox === undefined) delete process.env.ORCH_SANDBOX
      else process.env.ORCH_SANDBOX = oldSandbox
      if (oldDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = oldDepth
      rmSync(cwd, { recursive: true, force: true })
      rmSync(script, { force: true })
    }
  })

  test('a resumed findings turn records its review against the root run', async () => {
    const agent = AGENTS.codex!
    const original = {
      bin: agent.bin, resumeArgv: agent.resumeArgv, stdin: agent.stdin,
      readsOut: agent.readsOut, parseReply: agent.parseReply,
    }
    const priorDepth = process.env.ORCH_DEPTH
    const script = join(dir, `resumed-review-${Math.random().toString(16).slice(2)}.ts`)
    const promptPath = join(dir, `resumed-review-${Math.random().toString(16).slice(2)}.prompt.txt`)
    const root = addRun({
      agent: 'codex', job: 'review-lens-inline', status: 'asking',
      session: 'orch-test-session', lens: 'resumed-review',
    })
    writeFileSync(script, `process.stdout.write(${JSON.stringify(JSON.stringify(reviewReply(1)))})\n`)
    writeFileSync(promptPath, 'original review prompt')
    db().query('UPDATE run SET prompt_path=?, vendor_session=? WHERE id=?')
      .run(promptPath, 'review-vendor-session', root)
    try {
      agent.bin = process.execPath
      agent.resumeArgv = () => [script]
      agent.stdin = false
      agent.readsOut = false
      agent.parseReply = undefined
      process.env.ORCH_DEPTH = '0'
      const resumed = await runJob({
        job: 'review-lens-inline', prompt: 'continue', agent: 'codex',
        lens: 'resumed-review',
        resume: {
          parent: root, agent: 'codex', session: 'review-vendor-session', turn: 2,
          sessionId: 'orch-test-session', worktree: null,
        },
      })
      expect(resumed.status).toBe('ok')
      expect(db().query('SELECT status FROM run WHERE id=?').get(root)).toEqual({ status: 'ok' })
      expect(db().query('SELECT review_id FROM review_lens WHERE run_id=?').get(root)).not.toBeNull()
      expect(db().query('SELECT review_id FROM review_lens WHERE run_id=?').get(resumed.id)).toBeNull()
    } finally {
      agent.bin = original.bin
      agent.resumeArgv = original.resumeArgv
      agent.stdin = original.stdin
      agent.readsOut = original.readsOut
      agent.parseReply = original.parseReply
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(script, { force: true })
      rmSync(promptPath, { force: true })
    }
  })

  test('run 1715 shape completes as unevidenced and result wraps it as incomplete', async () => {
    const agent = AGENTS.codex!
    const original = { bin: agent.bin, argv: agent.argv, stdin: agent.stdin, readsOut: agent.readsOut }
    const priorDepth = process.env.ORCH_DEPTH
    const reply = reviewReply(0) as any
    reply.provenance.standards_read = []
    reply.provenance.files_covered = []
    reply.provenance.commands_run = []
    reply.provenance.could_not_verify = ['Full operator prompt not yet read']
    let runId: number | undefined
    try {
      agent.bin = process.execPath
      agent.argv = () => ['-e', `console.log(${JSON.stringify(JSON.stringify(reply))})`]
      agent.stdin = false
      agent.readsOut = false
      process.env.ORCH_DEPTH = '0'
      try {
        await runJob({
          job: 'review-lens-inline', prompt: 'inspect this pack', agent: 'codex',
          lens: 'empty', noFailover: true,
        })
      } catch (cause) {
        runId = (cause as Error & { runId?: number }).runId
      }
      expect(runId).toBeNumber()
      expect(db().query('SELECT status, failure_kind, error FROM run WHERE id=?').get(runId!))
        .toEqual({
          status: 'failed', failure_kind: 'unevidenced',
          error: expect.stringContaining(
            'clean review with no evidence: files_covered and commands_run are empty',
          ),
        })
      const shown = Bun.spawnSync([
        process.execPath, new URL('cli.ts', import.meta.url).pathname, 'result', String(runId),
      ], {
        env: {
          ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
          CLAUDE_CODE_SESSION_ID: 'orch-test-session',
        },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(shown.exitCode).toBe(1)
      expect(shown.stderr.toString()).toContain('unevidenced')
      expect(JSON.parse(shown.stdout.toString()).run.complete).toBe(false)
      const runs = Bun.spawnSync([
        process.execPath, new URL('cli.ts', import.meta.url).pathname, 'runs', '--id', String(runId),
      ], {
        env: {
          ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
          CLAUDE_CODE_SESSION_ID: 'orch-test-session',
        },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(runs.stdout.toString()).toContain('unevidenced')
      const score = Bun.spawnSync([
        process.execPath, new URL('cli.ts', import.meta.url).pathname,
        'score', String(runId), 'none', '--force',
      ], {
        env: {
          ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
          CLAUDE_CODE_SESSION_ID: 'orch-test-session',
        },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(score.exitCode).toBe(1)
      expect(score.stderr.toString()).toContain('unevidenced review')
      expect(db().query('SELECT id FROM score WHERE run_id=?').get(runId!)).toBeNull()
      expect(db().query('SELECT id FROM review_lens WHERE run_id=?').get(runId!)).toBeNull()
    } finally {
      agent.bin = original.bin
      agent.argv = original.argv
      agent.stdin = original.stdin
      agent.readsOut = original.readsOut
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  }, 20_000)

  test('explicit review records the trunk merge-base for clean-review evidence', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-explicit-review-evidence-'))
    const script = join(dir, 'report-explicit-review-evidence.ts')
    const agent = AGENTS.codex!
    const original = {
      bin: agent.bin, argv: agent.argv, stdin: agent.stdin,
      readsOut: agent.readsOut, parseReply: agent.parseReply,
    }
    const oldDepth = process.env.ORCH_DEPTH
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
      writeFileSync(script, `console.log(${JSON.stringify(JSON.stringify(reply))})\n`)
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
      agent.bin = process.execPath
      agent.argv = () => [script]
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
        process.execPath, new URL('cli.ts', import.meta.url).pathname,
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
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('implicit review measures from the constructed trunk merge-base', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-implicit-review-evidence-'))
    const script = join(dir, 'report-implicit-review-evidence.ts')
    const agent = AGENTS.codex!
    const original = {
      bin: agent.bin, argv: agent.argv, stdin: agent.stdin,
      readsOut: agent.readsOut, parseReply: agent.parseReply,
    }
    const oldDepth = process.env.ORCH_DEPTH
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
      writeFileSync(script, `console.log(${JSON.stringify(JSON.stringify(reply))})\n`)
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
      agent.bin = process.execPath
      agent.argv = () => [script]
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
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('an unregistered implicit review fails as harness naming the project', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-unregistered-review-'))
    const script = join(dir, 'report-unregistered-review.ts')
    const agent = AGENTS.codex!
    const original = {
      bin: agent.bin, argv: agent.argv, stdin: agent.stdin,
      readsOut: agent.readsOut, parseReply: agent.parseReply,
    }
    const oldDepth = process.env.ORCH_DEPTH
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    try {
      git('init', '-b', 'develop')
      git('config', 'user.email', 'orch-test@example.invalid')
      git('config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, 'changed.txt'), 'change\n')
      git('add', '.')
      git('commit', '-m', 'fixture')
      const reply = reviewReply(0)
      reply.provenance.files_covered = ['changed.txt']
      writeFileSync(script, `console.log(${JSON.stringify(JSON.stringify(reply))})\n`)
      agent.bin = process.execPath
      agent.argv = () => [script]
      agent.stdin = false
      agent.readsOut = false
      agent.parseReply = undefined
      process.env.ORCH_DEPTH = '0'
      let runId: number | undefined
      try {
        await runJob({
          job: 'review-lens', prompt: 'inspect', cwd: repo, agent: 'codex',
          lens: 'unregistered-evidence', repo: 'ghost-unregistered-project', noFailover: true,
        })
      } catch (cause) {
        runId = (cause as Error & { runId?: number }).runId
      }
      expect(runId).toBeNumber()
      expect(db().query('SELECT status, failure_kind, error FROM run WHERE id=?').get(runId!))
        .toEqual({
          status: 'failed', failure_kind: 'harness',
          error: expect.stringContaining('project ghost-unregistered-project is not registered'),
        })
      expect(db().query('SELECT id FROM review_lens WHERE run_id=?').get(runId!)).toBeNull()
    } finally {
      agent.bin = original.bin
      agent.argv = original.argv
      agent.stdin = original.stdin
      agent.readsOut = original.readsOut
      agent.parseReply = original.parseReply
      if (oldDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = oldDepth
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('explicit review refs select and record the reviewed branch tip', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-explicit-review-'))
    const branchTree = join(repo, 'feature-tree')
    const script = join(dir, 'report-explicit-review.ts')
    const agent = AGENTS.codex!
    const original = {
      bin: agent.bin, argv: agent.argv, stdin: agent.stdin,
      readsOut: agent.readsOut, parseReply: agent.parseReply,
    }
    const oldDepth = process.env.ORCH_DEPTH
    const git = (cwd: string, ...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    try {
      git(repo, 'init', '-b', 'main')
      git(repo, 'config', 'user.email', 'orch-test@example.invalid')
      git(repo, 'config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, 'subject.txt'), 'trunk\n')
      git(repo, 'add', 'subject.txt')
      git(repo, 'commit', '-m', 'fixture trunk')
      git(repo, 'worktree', 'add', '-b', 'feature/reviewed', branchTree)
      writeFileSync(join(branchTree, 'subject.txt'), 'branch\n')
      git(branchTree, 'add', 'subject.txt')
      git(branchTree, 'commit', '-m', 'fixture branch')
      const tip = git(repo, 'rev-parse', 'feature/reviewed^{commit}')
      const tree = git(repo, 'rev-parse', 'feature/reviewed^{tree}')
      upsertProject({ name: 'explicit-review-fixture', path: repo, settings: { trunk: 'main' } })
      writeFileSync(script, [
        "const view = { cwd: process.cwd(), text: await Bun.file('subject.txt').text() }",
        `const reply = ${JSON.stringify(reviewReply(0))}`,
        "reply.provenance.files_covered = ['subject.txt']",
        "reply.provenance.docs_read = [JSON.stringify(view)]",
        "console.log(JSON.stringify(reply))",
      ].join('\n'))
      agent.bin = process.execPath
      agent.argv = () => [script]
      agent.stdin = false
      agent.readsOut = false
      agent.parseReply = undefined
      process.env.ORCH_DEPTH = '0'

      const byBranch = await runJob({
        job: 'review-lens', prompt: 'inspect', cwd: repo, agent: 'codex',
        lens: 'explicit', review: 'feature/reviewed', keepTree: true,
      })
      expect(git(byBranch.worktree!.path, 'rev-parse', 'HEAD')).toBe(tip)
      expect(Bun.spawnSync(['git', 'symbolic-ref', '-q', 'HEAD'], {
        cwd: byBranch.worktree!.path, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      }).exitCode).not.toBe(0)
      expect(JSON.parse(JSON.parse(byBranch.output).provenance.docs_read[0]).text).toBe('branch\n')
      expect(db().query(
        'SELECT branch, base_commit, input_tree, head_commit, review_ref FROM run WHERE id=?',
      ).get(byBranch.id)).toEqual({
        branch: 'feature/reviewed', base_commit: git(repo, 'rev-parse', 'main'),
        input_tree: tree, head_commit: tip, review_ref: 'feature/reviewed',
      })
      const explicitReview = (db().query('SELECT review_id FROM review_lens WHERE run_id=?').get(byBranch.id) as
        { review_id: number }).review_id
      completeReview(explicitReview)
      expect(coverageAudit()).toEqual({ count: 0, review_ids: [], partial_review_ids: [] })

      const sourceRun = addRun({ agent: 'codex', job: 'implement' })
      db().query('UPDATE run SET branch=? WHERE id=?').run('feature/reviewed', sourceRun)
      const byRun = await runJob({
        job: 'craft', prompt: 'inspect', cwd: repo, agent: 'codex',
        lens: 'by-run', review: String(sourceRun), keepTree: true,
      })
      expect(git(byRun.worktree!.path, 'rev-parse', 'HEAD')).toBe(tip)
      expect(db().query('SELECT review_ref FROM run WHERE id=?').get(byRun.id))
        .toEqual({ review_ref: String(sourceRun) })

      expect(() => resolveReviewTarget('implement', repo, 'feature/reviewed'))
        .toThrow('--review is only valid')
      expect(() => resolveReviewTarget('review-lens', repo, 'feature/reviewed', true))
        .toThrow("run --carry from that branch's own worktree")

      writeFileSync(join(branchTree, 'overlay.txt'), 'overlay\n')
      const carried = await runJob({
        job: 'safety', prompt: 'inspect', cwd: branchTree, agent: 'codex',
        lens: 'carried-review', review: 'feature/reviewed', carry: true, keepTree: true,
      })
      expect(readFileSync(join(carried.worktree!.path, 'overlay.txt'), 'utf8')).toBe('overlay\n')
      expect(git(carried.worktree!.path, 'rev-parse', 'HEAD')).toBe(tip)
      const oldObjectDirectory = process.env.GIT_OBJECT_DIRECTORY
      const oldAlternates = process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES
      const expectedWarning = `reviewing main at ${git(repo, 'rev-parse', 'HEAD').slice(0, 8)}; pass --review <branch> to be explicit`
      expect(implicitReviewWarning(repo)).toBe(expectedWarning)
      process.env.GIT_OBJECT_DIRECTORY = '/foreign/object-directory'
      process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = '/foreign/alternates'
      try {
        expect(implicitReviewWarning(repo)).toContain(`at ${git(repo, 'rev-parse', 'HEAD').slice(0, 8)};`)
      } finally {
        if (oldObjectDirectory === undefined) delete process.env.GIT_OBJECT_DIRECTORY
        else process.env.GIT_OBJECT_DIRECTORY = oldObjectDirectory
        if (oldAlternates === undefined) delete process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES
        else process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = oldAlternates
      }

      writeFileSync(join(repo, 'unrelated.txt'), 'trunk moved independently\n')
      git(repo, 'add', 'unrelated.txt')
      git(repo, 'commit', '-m', 'unrelated trunk move')
      git(branchTree, 'rebase', 'main')
      const coverage = landingReviewCoverage(branchTree)
      expect(coverage).toContain(`review ${explicitReview}: carried (patch-id `)
    } finally {
      agent.bin = original.bin
      agent.argv = original.argv
      agent.stdin = original.stdin
      agent.readsOut = original.readsOut
      agent.parseReply = original.parseReply
      if (oldDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = oldDepth
      rmSync(repo, { recursive: true, force: true })
      rmSync(script, { force: true })
    }
  })

  test('runs from an empty directory while review-lens still receives the project tree', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-inline-boundary-'))
    const script = join(dir, 'report-worker-cwd.ts')
    const agent = AGENTS.codex!
    const original = {
      bin: agent.bin, argv: agent.argv, stdin: agent.stdin,
      readsOut: agent.readsOut, parseReply: agent.parseReply,
    }
    const oldDepth = process.env.ORCH_DEPTH
    const runGit = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    try {
      runGit('init', '-b', 'main')
      runGit('config', 'user.email', 'orch-test@example.invalid')
      runGit('config', 'user.name', 'Orch Test')
      mkdirSync(join(repo, 'subdir'))
      writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n')
      writeFileSync(join(repo, 'project-only.txt'), 'wrong tree evidence\n')
      writeFileSync(join(repo, 'subdir', 'subject.txt'), 'nested evidence\n')
      runGit('add', '.gitignore', 'project-only.txt', 'subdir/subject.txt')
      runGit('commit', '-m', 'fixture')
      writeFileSync(script, [
        "import { existsSync, readFileSync, statSync } from 'node:fs'",
        "const prompt = await Bun.stdin.text()",
        "let plantedMcp = false",
        "try { plantedMcp = readFileSync('.mcp.json', 'utf8').includes('STALE_TRUST') } catch {}",
        "const view = {",
        "  cwd: process.cwd(),",
        "  prompt,",
        "  checkout: existsSync('.git'),",
        "  projectFile: existsSync('project-only.txt'),",
        "  plantedMcp,",
        "  mode: statSync('.').mode & 0o777,",
        "  parentMode: statSync('..').mode & 0o777,",
        "  receivedPack: prompt.includes('SELF_CONTAINED_FACT'),",
        "}",
        "if (prompt.includes('CAPTURE_NO_REPO')) { console.log(JSON.stringify(view)); process.exit(0) }",
        `const reply = ${JSON.stringify(reviewReply(1))}`,
        "reply.findings[0].evidence = JSON.stringify(view)",
        "console.log(JSON.stringify(reply))",
      ].join('\n'))
      agent.bin = process.execPath
      agent.argv = () => [script]
      agent.stdin = true
      agent.readsOut = false
      agent.parseReply = undefined
      process.env.ORCH_DEPTH = '0'

      const inline = await runJob({
        job: 'review-lens-inline', prompt: 'SELF_CONTAINED_FACT', cwd: repo, agent: 'codex', lens: 'inline',
      })
      const inlineView = JSON.parse(JSON.parse(inline.output).findings[0].evidence) as {
        cwd: string; prompt: string; checkout: boolean; projectFile: boolean
        mode: number; parentMode: number; receivedPack: boolean
      }
      expect(inlineView.checkout).toBe(false)
      expect(inlineView.projectFile).toBe(false)
      expect(inlineView.mode).toBe(0o700)
      expect(inlineView.parentMode).toBe(0o700)
      expect(inlineView.receivedPack).toBe(true)
      expect(inlineView.cwd).toContain(`/isolates/${inline.id}`)
      expect(existsSync(inlineView.cwd)).toBe(false)
      expect(inline.worktree).toBeNull()
      expect(db().query('SELECT input_tree, head_commit FROM run WHERE id=?').get(inline.id))
        .toEqual({ input_tree: null, head_commit: null })

      // Recreate the exact removed pathname and plant the trust-triggering
      // filename from the incident. A later run id must select a different
      // pathname rather than inheriting anything from this one.
      mkdirSync(inlineView.cwd, { recursive: true })
      writeFileSync(join(inlineView.cwd, '.mcp.json'), 'STALE_TRUST\n')

      const isolatePaths = new Set([inlineView.cwd])
      for (const job of ['summarize', 'mcp-query'] as const) {
        const isolated = await runJob({
          job, prompt: 'CAPTURE_NO_REPO', cwd: repo, agent: 'codex', noFailover: true,
        })
        const view = JSON.parse(isolated.output) as {
          cwd: string; checkout: boolean; projectFile: boolean
          plantedMcp: boolean; mode: number; parentMode: number
        }
        expect(view.cwd).toContain(`/isolates/${isolated.id}`)
        expect(view.cwd).not.toBe(inlineView.cwd)
        expect(view.checkout).toBe(false)
        expect(view.projectFile).toBe(false)
        expect(view.plantedMcp).toBe(false)
        expect(view.mode).toBe(0o700)
        expect(view.parentMode).toBe(0o700)
        expect(isolatePaths.has(view.cwd)).toBe(false)
        isolatePaths.add(view.cwd)
        expect(existsSync(view.cwd)).toBe(false)
        expect(isolated.worktree).toBeNull()
        expect(db().query('SELECT cwd, worktree, input_tree, head_commit FROM run WHERE id=?').get(isolated.id))
          .toEqual({
            cwd: expect.stringContaining(`/isolates/${isolated.id}`),
            worktree: null, input_tree: null, head_commit: null,
          })
      }
      expect(isolatePaths.size).toBe(3)

      const repository = await runJob({
        job: 'review-lens', prompt: `inspect ${repo}/project-only.txt`,
        cwd: repo, agent: 'codex', lens: 'project', keepTree: true,
      })
      const repositoryView = JSON.parse(JSON.parse(repository.output).findings[0].evidence) as {
        prompt: string; checkout: boolean; projectFile: boolean
      }
      expect(repositoryView.checkout).toBe(true)
      expect(repositoryView.projectFile).toBe(true)
      expect(repository.worktree?.path).toBeTruthy()
      expect(repositoryView.prompt).toContain(`${repository.worktree!.path}/project-only.txt`)
      expect(repositoryView.prompt).not.toContain(`${repo}/project-only.txt`)
      expect(db().query('SELECT input_tree, head_commit FROM run WHERE id=?').get(repository.id))
        .toEqual({
          input_tree: runGit('rev-parse', 'HEAD^{tree}'),
          head_commit: runGit('rev-parse', 'HEAD^{commit}'),
        })

      const nested = await runJob({
        job: 'review-lens', prompt: `inspect ${repo}/subdir/subject.txt`,
        cwd: join(repo, 'subdir'), agent: 'codex', lens: 'nested', keepTree: true,
      })
      const nestedView = JSON.parse(JSON.parse(nested.output).findings[0].evidence) as { prompt: string }
      expect(nestedView.prompt).toContain(`${nested.worktree!.path}/subdir/subject.txt`)
      expect(nestedView.prompt).not.toContain(`${nested.worktree!.path}/subject.txt`)

      writeFileSync(join(repo, 'project-only.txt'), 'carried tracked evidence\n')
      writeFileSync(join(repo, 'carried.txt'), 'carried untracked evidence\n')
      writeFileSync(join(repo, 'ignored.txt'), 'must not enter the tree\n')
      const callerIndex = runGit('write-tree')
      const carried = await runJob({
        job: 'review-lens', prompt: 'inspect carried content', cwd: repo, agent: 'codex',
        lens: 'carried', carry: true, keepTree: true,
      })
      const expected = contentTree(carried.worktree!.path)
      expect(db().query('SELECT input_tree, head_commit FROM run WHERE id=?').get(carried.id))
        .toEqual({ input_tree: expected, head_commit: runGit('rev-parse', 'HEAD^{commit}') })
      expect(runGit('write-tree')).toBe(callerIndex)
      expect(readFileSync(join(carried.worktree!.path, 'project-only.txt'), 'utf8'))
        .toBe('carried tracked evidence\n')
      expect(readFileSync(join(carried.worktree!.path, 'carried.txt'), 'utf8'))
        .toBe('carried untracked evidence\n')
      expect(existsSync(join(carried.worktree!.path, 'ignored.txt'))).toBe(false)
    } finally {
      agent.bin = original.bin
      agent.argv = original.argv
      agent.stdin = original.stdin
      agent.readsOut = original.readsOut
      agent.parseReply = original.parseReply
      if (oldDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = oldDepth
      rmSync(repo, { recursive: true, force: true })
      const inlineRows = db().query(
        "SELECT cwd FROM run WHERE job IN ('review-lens-inline', 'summarize', 'mcp-query') AND cwd LIKE '%/isolates/%'",
      ).all() as { cwd: string }[]
      for (const row of inlineRows) rmSync(row.cwd, { recursive: true, force: true })
      rmSync(script, { force: true })
    }
  })
})

describe('findings routing narrows to a lens only when that buys a comparison', () => {
  const judgedLensRun = (
    agent: string, lens: string, quality: 'wrong' | 'mixed' | 'right', recorded = true,
  ) => {
    const runId = addRun({ agent, job: 'review-lens', lens })
    if (recorded) recordReview(runId, reviewReply(0))
    score(runId, 'full', quality)
    return runId
  }

  test('two proven lens cells can route the same job to different agents', () => {
    for (let i = 0; i < MIN_SAMPLE; i++) {
      judgedLensRun('codex', 'correctness', 'right')
      judgedLensRun('grok', 'correctness', 'wrong')
      judgedLensRun('codex', 'migration-safety', 'wrong')
      judgedLensRun('grok', 'migration-safety', 'right')
    }
    const correctness = pick('review-lens', undefined, 0, false, null, {}, false, 'correctness')
    const migration = pick('review-lens', undefined, 0, false, null, {}, false, 'migration-safety')
    expect(correctness.agent).toBe('codex')
    expect(correctness.reason).toContain('lens correctness cell')
    expect(migration.agent).toBe('grok')
    expect(migration.reason).toContain('lens migration-safety cell')

    const cli = new URL('cli.ts', import.meta.url).pathname
    const correctnessCli = Bun.spawnSync(
      [process.execPath, cli, 'pick', 'review-lens', '--lens', 'correctness'],
      { env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' }, stdout: 'pipe', stderr: 'pipe' },
    )
    const migrationCli = Bun.spawnSync(
      [process.execPath, cli, 'pick', 'review-lens', '--lens', 'migration-safety'],
      { env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' }, stdout: 'pipe', stderr: 'pipe' },
    )
    expect(correctnessCli.exitCode).toBe(0)
    expect(correctnessCli.stdout.toString()).toContain('review-lens -> codex')
    expect(correctnessCli.stdout.toString()).toContain('deciding cell: lens correctness')
    expect(migrationCli.exitCode).toBe(0)
    expect(migrationCli.stdout.toString()).toContain('review-lens -> grok')
    expect(migrationCli.stdout.toString()).toContain('deciding cell: lens migration-safety')
  })

  test('one proven agent on a lens backs off to the job-wide cell', () => {
    for (let i = 0; i < MIN_SAMPLE; i++) {
      judgedLensRun('codex', 'correctness', 'wrong')
      judgedLensRun('grok', 'unrecorded', 'right', false)
    }
    const ev = evidenceFor('review-lens', 0, null, undefined, 'correctness')
    expect(ev.level).toBe('job')
    expect(ev.scoped!.find((candidate) => candidate.agent === 'codex')!.evidence).toBe(MIN_SAMPLE)
    const routed = pick('review-lens', undefined, 0, false, null, {}, false, 'correctness')
    expect(routed.agent).toBe('grok')
    expect(routed.reason).toContain('job-wide cell')
  })

  test('a scored run without a recorded review lens contributes only job-wide', () => {
    judgedLensRun('codex', 'correctness', 'right', false)
    const ev = evidenceFor('review-lens', 0, null, undefined, 'correctness')
    expect(ev.job.find((candidate) => candidate.agent === 'codex')!.evidence).toBe(1)
    expect(ev.scoped!.find((candidate) => candidate.agent === 'codex')!.evidence).toBe(0)
  })

  test('guide names the deciding cell and reports lens and job-wide counts', () => {
    for (let i = 0; i < MIN_SAMPLE; i++) {
      judgedLensRun('codex', 'correctness', 'right')
      judgedLensRun('grok', 'correctness', 'mixed')
    }
    const row = guide('review-lens', 0, 'correctness')[0]!
    expect(row.reason).toContain('lens correctness cell')
    expect(row.evidenceCells).toEqual([
      { name: 'lens correctness', counts: expect.arrayContaining([
        { agent: 'codex', evidence: MIN_SAMPLE }, { agent: 'grok', evidence: MIN_SAMPLE },
      ]) },
      { name: 'job-wide', counts: expect.arrayContaining([
        { agent: 'codex', evidence: MIN_SAMPLE }, { agent: 'grok', evidence: MIN_SAMPLE },
      ]) },
    ])
    const cli = Bun.spawnSync([
      process.execPath, new URL('cli.ts', import.meta.url).pathname,
      'guide', '--job', 'review-lens', '--prompt-bytes', '0', '--lens', 'correctness',
    ], {
      env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(cli.exitCode).toBe(0)
    expect(cli.stdout.toString()).toContain('evidence lens correctness: codex=5, grok=5')
    expect(cli.stdout.toString()).toContain('evidence job-wide: codex=5, grok=5')
    expect(cli.stdout.toString()).toContain('lens correctness cell')
  })
})
