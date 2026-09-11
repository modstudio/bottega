// Tests run.ts: worker-result finalization and contract outcomes.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FAILS_OVER, addRun, createWorktree, db, dir, hermeticGitEnv, runJob, workerReply, workerSharedGitRoots, worktreeGitDir } from '../test/fixture.ts'
import { scriptedTransportSequence } from '../test/fake-transport.ts'

describe('a writing worker must return evidence of completed work', () => {
  const hasPendingQuestion = () => Boolean(db().query(
    'SELECT 1 FROM question WHERE answer IS NULL LIMIT 1',
  ).get())

  async function runInCleanTree(output: string): Promise<Awaited<ReturnType<typeof runJob>>> {
    const repo = mkdtempSync(join(tmpdir(), 'orch-empty-write-'))
    writeFileSync(join(repo, 'seed.txt'), 'seed\n')
    for (const args of [['init'], ['add', 'seed.txt']]) {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    }
    const committed = Bun.spawnSync(['git', '-c', 'user.name=Orch Test',
      '-c', 'user.email=orch@example.invalid', 'commit', '-m', 'seed'], {
      cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    if (committed.exitCode !== 0) throw new Error(committed.stderr.toString())
    const tree = createWorktree(repo, 76)
    const transport = scriptedTransportSequence([[{ kind: 'completed', output }]])
    transport.install()
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    const parent = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    const rootPrompt = join(dir, `write-root-${parent}.prompt.txt`)
    writeFileSync(rootPrompt, 'original implementation spec')
    db().query('UPDATE run SET prompt_path=? WHERE id=?').run(rootPrompt, parent)
    try {
      return await runJob({
        job: 'implement', prompt: 'continue', cwd: tree.path,
        noFailover: true,
        resume: {
          parent, agent: 'codex', session: 'test-session', turn: 2,
          sessionId: 'orch-test-session',
          worktree: tree,
        },
      })
    } finally {
      const options = transport.startOptions()[0]!
      expect(options.sandbox).toBe('workspace-write')
      expect(options.writableRoots![0]?.endsWith('/scratch')).toBe(true)
      expect(options.writableRoots!.slice(1)).toEqual([
        worktreeGitDir(tree.path), ...workerSharedGitRoots(tree.path, tree.branch),
      ])
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(repo, { recursive: true, force: true })
      rmSync(rootPrompt, { force: true })
    }
  }

  async function runResumedNoRepositoryJob(
    inspectOptions: (options: {
      writableRoots?: string[]
      gitConfigEnvironment?: Record<string, string>
    }, tree: ReturnType<typeof createWorktree>) => void,
  ): Promise<void> {
    const repo = mkdtempSync(join(tmpdir(), 'orch-no-repo-resume-'))
    const promptPath = join(dir, `no-repo-resume-${Math.random().toString(16).slice(2)}.prompt.txt`)
    writeFileSync(join(repo, 'seed.txt'), 'seed\n')
    for (const args of [['init'], ['add', 'seed.txt']]) {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    }
    const committed = Bun.spawnSync([
      'git', '-c', 'user.name=Orch Test', '-c', 'user.email=orch@example.invalid',
      'commit', '-m', 'seed',
    ], { cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' })
    if (committed.exitCode !== 0) throw new Error(committed.stderr.toString())
    const tree = createWorktree(repo, 462)
    const transport = scriptedTransportSequence([[{ kind: 'completed', output: 'summary' }]])
    transport.install()
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    const parent = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    writeFileSync(promptPath, 'original implementation spec')
    db().query('UPDATE run SET prompt_path=? WHERE id=?').run(promptPath, parent)
    try {
      await runJob({
        job: 'summarize', prompt: 'summarize', cwd: tree.path, noFailover: true,
        resume: {
          parent, agent: 'codex', session: 'test-session', turn: 2,
          sessionId: 'orch-test-session', worktree: tree,
        },
      })
    } finally {
      inspectOptions(transport.startOptions()[0]!, tree)
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(repo, { recursive: true, force: true })
      rmSync(promptPath, { force: true })
    }
  }

  test('a resumed no-repository job receives no worktree Git writable root', async () => {
    await runResumedNoRepositoryJob((options, tree) => {
      expect(options.writableRoots).toEqual([expect.stringMatching(/\/scratch$/)])
      expect(options.writableRoots).not.toContain(worktreeGitDir(tree.path))
    })
  })

  test('done with no claimed or measured change and no test run is failed', async () => {
    let failure: Error & { runId?: number } | null = null
    try {
      await runInCleanTree(JSON.stringify(workerReply({
        files_changed: [], tests: { command: null, ran: false, passed: null, detail: null },
      })))
    } catch (e) {
      failure = e as Error & { runId?: number }
    }
    expect(failure?.message).toContain('reported done with no change and no test run')
    expect(failure?.runId).toBeDefined()
    const row = db().query('SELECT status, error, files_changed, changed_paths, route_reason FROM run WHERE id=?')
      .get(failure!.runId!) as {
        status: string; error: string; files_changed: number; changed_paths: string; route_reason: string
      }
    expect(row.status).toBe('failed')
    expect(row.files_changed).toBe(0)
    expect(JSON.parse(row.changed_paths)).toEqual([])
    expect(row.error).toContain('reported done with no change and no test run')
    expect(row.error).not.toContain('review path retargeting indeterminate:')
    expect(row.route_reason).toContain(
      'repository path retargeting not applied because the turn is already bound to its worktree',
    )
  })

  test('run 1743 placeholder shape is a visible contract failure with no question', async () => {
    const reply = JSON.stringify(workerReply({
      status: 'asking',
      summary: 'Reading the full spec and checking orchestrator messages before implementing.',
      files_changed: null,
      questions: [{
        question: 'placeholder', options: null, recommendation: null, why: null,
      }],
      tests: null,
    }))
    let failure: Error & { runId?: number } | null = null
    try { await runInCleanTree(reply) } catch (e) { failure = e as Error & { runId?: number } }
    expect(failure?.runId).toBeDefined()
    const id = failure!.runId!
    expect(db().query(
      'SELECT status, failure_kind, error, escalations FROM run WHERE id=?',
    ).get(id)).toEqual({
      status: 'failed', failure_kind: 'contract', escalations: 0,
      error: expect.stringContaining('rejected question text: "placeholder"'),
    })
    expect((db().query('SELECT COUNT(*) n FROM question WHERE run_id=?').get(id) as { n: number }).n)
      .toBe(0)

    expect(hasPendingQuestion()).toBe(false)
  })

  test('asking with text but empty why is a contract failure', async () => {
    let failure: Error & { runId?: number } | null = null
    try {
      await runInCleanTree(JSON.stringify(workerReply({
        status: 'asking', files_changed: null, tests: null,
        questions: [{
          question: 'one table or two?', options: null, recommendation: null, why: ' ',
        }],
      })))
    } catch (e) { failure = e as Error & { runId?: number } }
    expect(db().query('SELECT status, failure_kind FROM run WHERE id=?').get(failure!.runId!))
      .toEqual({ status: 'failed', failure_kind: 'contract' })
  })

  test('format-only why is a contract failure', async () => {
    for (const why of ['\u200B', '\u2060', '\u00AD', '\u200B\u2060']) {
      let failure: Error & { runId?: number } | null = null
      try {
        await runInCleanTree(JSON.stringify(workerReply({
          status: 'asking', files_changed: null, tests: null,
          questions: [{
            question: 'one table or two?', options: null, recommendation: null, why,
          }],
        })))
      } catch (e) { failure = e as Error & { runId?: number } }
      expect(failure?.runId).toBeDefined()
      const id = failure!.runId!
      expect(db().query('SELECT status, failure_kind, escalations FROM run WHERE id=?').get(id))
        .toEqual({ status: 'failed', failure_kind: 'contract', escalations: 0 })
      expect((db().query('SELECT COUNT(*) n FROM question WHERE run_id=?').get(id) as { n: number }).n)
        .toBe(0)
      expect(hasPendingQuestion()).toBe(false)
    }
  }, 15_000)

  test('punctuated generic and invisible-only questions fail in the run path', async () => {
    for (const question of ['(placeholder)!', '\u200B\u2060']) {
      let failure: Error & { runId?: number } | null = null
      try {
        await runInCleanTree(JSON.stringify(workerReply({
          status: 'asking', files_changed: null, tests: null,
          questions: [{
            question, options: null, recommendation: null, why: 'a claimed reason',
          }],
        })))
      } catch (e) { failure = e as Error & { runId?: number } }
      expect(failure?.runId).toBeDefined()
      const id = failure!.runId!
      expect(db().query('SELECT status, failure_kind FROM run WHERE id=?').get(id))
        .toEqual({ status: 'failed', failure_kind: 'contract' })
      expect((db().query('SELECT COUNT(*) n FROM question WHERE run_id=?').get(id) as { n: number }).n)
        .toBe(0)
    }
  })

  test('a real question and why are accepted and recorded as before', async () => {
    const result = await runInCleanTree(JSON.stringify(workerReply({
      status: 'asking', files_changed: null, tests: null,
      questions: [{
        question: 'one table or two?', options: ['one', 'two'], recommendation: 'two',
        why: 'the choice changes the public query shape',
      }],
    })))
    expect(result.status).toBe('asking')
    expect(db().query('SELECT question, why FROM question WHERE run_id=?').get(result.id))
      .toEqual({ question: 'one table or two?', why: 'the choice changes the public query shape' })
  })

  test('a real question beside a blank is accepted and only the real one is recorded', async () => {
    const result = await runInCleanTree(JSON.stringify(workerReply({
      status: 'asking', files_changed: null, tests: null,
      questions: [
        {
          question: 'which table?', options: null, recommendation: null,
          why: 'the schema changes',
        },
        { question: '   ', options: null, recommendation: null, why: 'unknown choice' },
      ],
    })))
    expect(result.status).toBe('asking')
    expect(db().query('SELECT question, why FROM question WHERE run_id=?').all(result.id))
      .toEqual([{ question: 'which table?', why: 'the schema changes' }])
    expect(db().query('SELECT error, escalations FROM run WHERE id=?').get(result.id)).toEqual({
      error: '1 invalid question dropped; rejected question text: "   "', escalations: 1,
    })
    expect(hasPendingQuestion()).toBe(true)
  })

  test('done carrying a real question is reclassified as asking', async () => {
    const result = await runInCleanTree(JSON.stringify(workerReply({
      status: 'done', questions: [{
        question: 'Which table?', options: null, recommendation: null,
        why: 'the schema changes',
      }],
    })))
    expect(result.status).toBe('asking')
    expect(db().query('SELECT status, error, escalations FROM run WHERE id=?').get(result.id))
      .toEqual({
        status: 'asking', escalations: 1,
        error: 'status reclassified from done to asking: a worker with a real question has not finished',
      })
    expect(db().query('SELECT question, why FROM question WHERE run_id=?').all(result.id))
      .toEqual([{ question: 'Which table?', why: 'the schema changes' }])
    expect(hasPendingQuestion()).toBe(true)
  })

  test('done carrying two real questions records both and remains asking', async () => {
    const result = await runInCleanTree(JSON.stringify(workerReply({
      status: 'done', questions: [
        { question: 'Which table?', options: null, recommendation: null, why: 'the schema changes' },
        { question: 'Which index?', options: null, recommendation: null, why: 'the query changes' },
      ],
    })))
    expect(result.status).toBe('asking')
    expect(db().query('SELECT question FROM question WHERE run_id=? ORDER BY id').all(result.id))
      .toEqual([{ question: 'Which table?' }, { question: 'Which index?' }])
    expect(db().query('SELECT escalations FROM run WHERE id=?').get(result.id))
      .toEqual({ escalations: 2 })
  })

  test('done carrying one real and one blank question records only the real one', async () => {
    const result = await runInCleanTree(JSON.stringify(workerReply({
      status: 'done', questions: [
        { question: 'Which table?', options: null, recommendation: null, why: 'the schema changes' },
        { question: ' ', options: null, recommendation: null, why: 'unknown choice' },
      ],
    })))
    expect(result.status).toBe('asking')
    expect(db().query('SELECT question FROM question WHERE run_id=?').all(result.id))
      .toEqual([{ question: 'Which table?' }])
    expect((db().query('SELECT error FROM run WHERE id=?').get(result.id) as { error: string }).error)
      .toBe('status reclassified from done to asking: a worker with a real question has not finished\n' +
        '1 invalid question dropped; rejected question text: " "')
  })

  test('done carrying only blank questions stays done and records the dropped blanks', async () => {
    const result = await runInCleanTree(JSON.stringify(workerReply({
      status: 'done', questions: [
        { question: ' ', options: null, recommendation: null, why: 'unknown choice' },
        { question: '\u200B', options: null, recommendation: null, why: '\u2060' },
      ],
    })))
    expect(result.status).toBe('ok')
    expect(db().query('SELECT error, escalations FROM run WHERE id=?').get(result.id)).toEqual({
      error: '2 invalid questions dropped; rejected question text: " ", "​"', escalations: 0,
    })
    expect((db().query('SELECT COUNT(*) n FROM question WHERE run_id=?').get(result.id) as { n: number }).n)
      .toBe(0)
    expect(hasPendingQuestion()).toBe(false)
  })

  test('done carrying no questions remains done', async () => {
    const result = await runInCleanTree(JSON.stringify(workerReply({ status: 'done', questions: null })))
    expect(result.status).toBe('ok')
    expect(db().query('SELECT error, escalations FROM run WHERE id=?').get(result.id))
      .toEqual({ error: null, escalations: 0 })
    expect((db().query('SELECT COUNT(*) n FROM question WHERE run_id=?').get(result.id) as { n: number }).n)
      .toBe(0)
  })

  test('an all-blank asking reply remains a failover-eligible contract failure', async () => {
    let failure: Error & { runId?: number } | null = null
    try {
      await runInCleanTree(JSON.stringify(workerReply({
        status: 'asking', files_changed: null, tests: null,
        questions: [
          { question: ' ', options: null, recommendation: null, why: 'unknown choice' },
          { question: '\u200B', options: null, recommendation: null, why: '\u2060' },
        ],
      })))
    } catch (e) { failure = e as Error & { runId?: number } }
    const id = failure!.runId!
    expect(db().query('SELECT status, failure_kind, escalations FROM run WHERE id=?').get(id))
      .toEqual({ status: 'failed', failure_kind: 'contract', escalations: 0 })
    expect((db().query('SELECT COUNT(*) n FROM question WHERE run_id=?').get(id) as { n: number }).n)
      .toBe(0)
    expect(FAILS_OVER).toContain('contract')
  })

})
