import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { AGENTS, FAILS_OVER, MIN_SAMPLE, addRun, applySchema, candidates, createWorktree, db, dir, hermeticGitEnv, nowIso, pendingForSession, recordSessionSeen, resolveRootFromLastTurn, resolveSupersededTurn, runJob, score, unscoredCount, weigh, workerReply, workerSharedGitRoots, worktreeGitDir } from '../test/fixture.ts'

describe('a writing worker must return evidence of completed work', () => {
  function heartbeat(): string {
    const hook = new URL('../hooks/orch-heartbeat.sh', import.meta.url).pathname
    const bin = new URL('../../bin/', import.meta.url).pathname
    const beat = Bun.spawnSync([hook, 'orch-test-session', '0', '1'], {
      env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, PATH: `${bin}:${process.env.PATH}` },
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(beat.exitCode).toBe(0)
    return beat.stdout.toString()
  }

  async function runInCleanTree(output: string): Promise<Awaited<ReturnType<typeof runJob>>> {
    const repo = mkdtempSync(join(tmpdir(), 'orch-empty-write-'))
    const script = join(dir, `worker-${Math.random().toString(16).slice(2)}.ts`)
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
    writeFileSync(script, `process.stdout.write(${JSON.stringify(output)})\n`)

    const agent = AGENTS.codex!
    const origBin = agent.bin
    const origResume = agent.resumeArgv
    const origReadsOut = agent.readsOut
    agent.bin = process.execPath
    agent.resumeArgv = (o) => {
      expect(o.sandbox).toBe('workspace-write')
      expect(o.writableRoots![0]?.endsWith('/scratch')).toBe(true)
      expect(o.writableRoots!.slice(1)).toEqual([
        worktreeGitDir(tree.path), ...workerSharedGitRoots(tree.path, tree.branch),
      ])
      return [script]
    }
    agent.readsOut = false
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
      agent.bin = origBin
      agent.resumeArgv = origResume
      agent.readsOut = origReadsOut
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(repo, { recursive: true, force: true })
      rmSync(script, { force: true })
      rmSync(rootPrompt, { force: true })
    }
  }

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

    const cli = (...args: string[]) => {
      const p = Bun.spawnSync([process.execPath, new URL('cli.ts', import.meta.url).pathname, ...args], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
    }
    const result = cli('result', String(id))
    expect(result.code).toBe(1)
    expect(result.err).toContain('contract')
    expect(result.err).toContain('rejected question text: "placeholder"')
    const runs = cli('runs')
    expect(runs.out).toContain('contract')
    expect(runs.out).toContain('rejected question text: "placeholder"')

    expect(heartbeat()).not.toContain('BLOCKED')
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
      expect(heartbeat()).not.toContain('BLOCKED')
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
    expect(heartbeat()).toContain('BLOCKED')
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
    expect(heartbeat()).toContain('BLOCKED')
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
    expect(heartbeat()).not.toContain('BLOCKED')
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

  test('multiple contracts leave a visible note on an otherwise successful run', async () => {
    const result = await runInCleanTree([
      workerReply({ summary: 'real reply' }),
      workerReply({ summary: 'quoted contract-shaped object' }),
    ].map((value) => JSON.stringify(value)).join('\n'))
    expect(result.contract?.summary).toBe('quoted contract-shaped object')
    expect((db().query('SELECT error FROM run WHERE id=?').get(result.id) as { error: string }).error)
      .toContain('2 contract objects in output; took the last')
  })
})

describe('a conversation is one unit of work, not one per turn', () => {
  const routingEvidenceIds = () => (db().query(
    `SELECT r.id FROM run r LEFT JOIN score s ON s.run_id=r.id
      WHERE r.status IN ('ok','failed','stale') AND r.probe=0
        AND r.evidence_excluded IS NULL AND r.parent_run_id IS NULL
        AND (s.delivery IS NOT NULL OR
             (r.status IN ('failed','stale') AND s.delivery IS NULL))
      ORDER BY r.id`,
  ).all() as { id: number }[]).map((row) => row.id)

  const resumeWithGrok = async (root: number, stdout: string) => {
    const script = join(dir, `resumed-grok-${root}-${Math.random().toString(16).slice(2)}.ts`)
    writeFileSync(script, `process.stdout.write(${JSON.stringify(stdout)})\n`)
    const grok = AGENTS.grok!
    const previous = {
      bin: grok.bin, resumeArgv: grok.resumeArgv, stdin: grok.stdin, readsOut: grok.readsOut,
    }
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      grok.bin = process.execPath
      grok.resumeArgv = () => [script]
      grok.stdin = false
      grok.readsOut = false
      try {
        return {
          result: await runJob({
            job: 'understand', prompt: 'continue', cwd: dir, noFailover: true,
            resume: {
              parent: root, agent: 'grok', session: 'test-session', turn: 2,
              sessionId: 'orch-test-session', worktree: null,
            },
          }),
          error: null,
        }
      } catch (error) {
        return { result: null, error: error as Error }
      }
    } finally {
      grok.bin = previous.bin
      grok.resumeArgv = previous.resumeArgv
      grok.stdin = previous.stdin
      grok.readsOut = previous.readsOut
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(script, { force: true })
    }
  }

  test('a three-turn chain resolves the intermediate asking turn end to end', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-three-turn-'))
    const script = join(dir, `three-turn-${Math.random().toString(16).slice(2)}.ts`)
    const promptPath = join(dir, `three-turn-${Math.random().toString(16).slice(2)}.prompt.txt`)
    writeFileSync(join(repo, 'seed.txt'), 'seed\n')
    for (const args of [['init'], ['add', 'seed.txt']]) {
      const p = Bun.spawnSync(['git', ...args], { cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    }
    const committed = Bun.spawnSync([
      'git', '-c', 'user.name=Orch Test', '-c', 'user.email=orch@example.invalid',
      'commit', '-m', 'seed',
    ], { cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' })
    if (committed.exitCode !== 0) throw new Error(committed.stderr.toString())
    const tree = createWorktree(repo, 137)

    const agent = AGENTS.codex!
    const originalBin = agent.bin
    const originalResume = agent.resumeArgv
    const originalReadsOut = agent.readsOut
    const priorDepth = process.env.ORCH_DEPTH
    agent.bin = process.execPath
    agent.resumeArgv = () => [script]
    agent.readsOut = false
    process.env.ORCH_DEPTH = '0'

    const root = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    writeFileSync(promptPath, 'original implementation spec')
    db().query('UPDATE run SET prompt_path=? WHERE id=?').run(promptPath, root)
    db().query(
      `INSERT INTO question (run_id, asked_at, question, answer, answered_at)
       VALUES (?,?,?,?,?)`,
    ).run(root, nowIso(), 'first question?', 'first ruling', nowIso())

    try {
      writeFileSync(script, `process.stdout.write(${JSON.stringify(JSON.stringify(workerReply({
        status: 'asking', summary: 'need a second ruling', files_changed: null,
        questions: [{
          question: 'second question?', options: ['one', 'two'], recommendation: 'one',
          why: 'the ruling changes the implementation',
        }],
      })))})\n`)
      const second = await runJob({
        job: 'implement', prompt: 'continue', cwd: tree.path,
        resume: {
          parent: root, agent: 'codex', session: 'test-session', turn: 2,
          sessionId: 'orch-test-session', worktree: tree,
        },
      })
      expect(second.status).toBe('asking')
      const question = db().query('SELECT id FROM question WHERE run_id=?').get(second.id) as { id: number }
      db().query('UPDATE question SET answer=?, answered_at=? WHERE id=?')
        .run('second ruling', nowIso(), question.id)

      writeFileSync(script, `process.stdout.write(${JSON.stringify(JSON.stringify(workerReply()))})\n`)
      const third = await runJob({
        job: 'implement', prompt: 'finish', cwd: tree.path,
        resume: {
          parent: root, agent: 'codex', session: 'test-session', turn: 3,
          sessionId: 'orch-test-session', worktree: tree,
        },
      })

      expect(db().query(
        'SELECT turn, status FROM run WHERE id=? OR parent_run_id=? ORDER BY turn',
      ).all(root, root)).toEqual([
        { turn: 1, status: 'ok' },
        { turn: 2, status: 'ok' },
        { turn: 3, status: 'ok' },
      ])
      expect(third.status).toBe('ok')
    } finally {
      agent.bin = originalBin
      agent.resumeArgv = originalResume
      agent.readsOut = originalReadsOut
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(repo, { recursive: true, force: true })
      rmSync(script, { force: true })
      rmSync(promptPath, { force: true })
    }
  })

  test('superseding an answered child resolves it without changing routing evidence', () => {
    const root = addRun({ agent: 'codex', job: 'implement' })
    score(root, 'full', 'right')
    const child = addRun({
      agent: 'codex', job: 'implement', status: 'asking', parent: root, turn: 2,
    })
    // A score makes the independent child predicate load-bearing: changing
    // only `asking` to `ok` would admit this row if parent_run_id stopped being
    // part of the router's evidence rule.
    score(child, 'full', 'right')
    db().query(
      `INSERT INTO question (run_id, asked_at, question, answer, answered_at)
       VALUES (?,?,?,?,?)`,
    ).run(child, nowIso(), 'which shape?', 'the ruled shape', nowIso())
    addRun({ agent: 'codex', job: 'implement', parent: root, turn: 3 })
    const before = routingEvidenceIds()

    expect(resolveSupersededTurn(db(), root, 2)).toBe(1)

    expect(db().query('SELECT status FROM run WHERE id=?').get(child)).toEqual({ status: 'ok' })
    expect(routingEvidenceIds()).toEqual(before)
    expect(candidates('implement').find((row) => row.agent === 'codex')?.evidence).toBe(1)
  })

  test('resolution is child-only, exact, and evidence-neutral', () => {
    const root = addRun({ agent: 'codex', job: 'implement' })
    score(root, 'full', 'right')
    const matched = addRun({
      agent: 'codex', job: 'implement', status: 'asking', parent: root, turn: 2,
    })
    score(matched, 'full', 'right')
    db().query(
      `INSERT INTO question (run_id, asked_at, question, answer, answered_at)
       VALUES (?,?,?,?,?)`,
    ).run(matched, nowIso(), 'which shape?', 'the ruled shape', nowIso())
    addRun({ agent: 'codex', job: 'implement', parent: root, turn: 3 })

    const unanswered = addRun({
      agent: 'codex', job: 'implement', status: 'asking', parent: root, turn: 4,
    })
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(unanswered, nowIso(), 'still waiting?')
    addRun({ agent: 'codex', job: 'implement', parent: root, turn: 5 })

    const noSuccessor = addRun({
      agent: 'codex', job: 'implement', status: 'asking', parent: root, turn: 6,
    })
    db().query(
      `INSERT INTO question (run_id, asked_at, question, answer, answered_at)
       VALUES (?,?,?,?,?)`,
    ).run(noSuccessor, nowIso(), 'latest question?', 'answered', nowIso())

    const askingRoot = addRun({ agent: 'grok', job: 'implement', status: 'asking' })
    db().query(
      `INSERT INTO question (run_id, asked_at, question, answer, answered_at)
       VALUES (?,?,?,?,?)`,
    ).run(askingRoot, nowIso(), 'root question?', 'answered', nowIso())
    addRun({ agent: 'grok', job: 'implement', parent: askingRoot, turn: 2 })
    const before = routingEvidenceIds()
    const statusOf = (id: number) => db().query('SELECT status FROM run WHERE id=?').get(id)

    // The bulk cutover script is gone; these are the boundaries of the rule it
    // enforced, which now lives in the write path and is what must not drift.
    expect(resolveSupersededTurn(db(), root, 2)).toBe(1)
    expect(statusOf(matched)).toEqual({ status: 'ok' })

    // An unanswered question means the turn is still waiting, not superseded.
    expect(resolveSupersededTurn(db(), root, 4)).toBe(0)
    expect(statusOf(unanswered)).toEqual({ status: 'asking' })

    // Nothing came after it, so nothing superseded it.
    expect(resolveSupersededTurn(db(), root, 6)).toBe(0)
    expect(statusOf(noSuccessor)).toEqual({ status: 'asking' })

    // A root is addressed as nobody's child, so it can never be resolved this
    // way however answered its question is. DEV-146 is the counterpart that
    // inherits the last turn's terminal status onto the root; this function
    // must still refuse, or the two rules fight.
    expect(resolveSupersededTurn(db(), askingRoot, 1)).toBe(0)
    expect(statusOf(askingRoot)).toEqual({ status: 'asking' })

    expect(routingEvidenceIds()).toEqual(before)
  })

  test('a stranded root inherits the last turn\'s terminal status and joins routing evidence', () => {
    // The 1095 shape: root still asking, last turn stale, questions answered.
    // DEV-137 pinned that child resolution must not move the evidence set.
    // This is the opposite: the root becoming stale is a new judgement.
    for (let i = 0; i < MIN_SAMPLE - 1; i++) {
      addRun({ agent: 'grok', job: 'implement', status: 'failed', kind: 'other' })
    }
    const root = addRun({ agent: 'grok', job: 'implement', status: 'asking' })
    score(root, 'none')
    db().query(
      `INSERT INTO question (run_id, asked_at, question, answer, answered_at)
       VALUES (?,?,?,?,?)`,
    ).run(root, nowIso(), 'root question?', 'answered', nowIso())
    addRun({
      agent: 'grok', job: 'implement', status: 'stale', parent: root, turn: 2, kind: 'abandoned',
    })

    const before = routingEvidenceIds()
    expect(before).not.toContain(root)
    const beforeGrok = candidates('implement').find((row) => row.agent === 'grok')!
    expect(beforeGrok.evidence).toBe(MIN_SAMPLE - 1)

    expect(resolveRootFromLastTurn(db(), root)).toBe(1)
    expect(db().query('SELECT status, failure_kind FROM run WHERE id=?').get(root))
      .toEqual({ status: 'stale', failure_kind: null })

    const after = routingEvidenceIds()
    expect(after).toEqual([...before, root].sort((a, b) => a - b))
    const afterGrok = candidates('implement').find((row) => row.agent === 'grok')!
    expect(afterGrok.evidence).toBe(MIN_SAMPLE)
    expect(afterGrok.scored).toBe(1)
  })

  test('a root waiting on a ruling is not stranded', () => {
    const root = addRun({ agent: 'grok', job: 'implement', status: 'asking' })
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(root, nowIso(), 'still waiting?')
    addRun({
      agent: 'grok', job: 'implement', status: 'stale', parent: root, turn: 2,
    })
    const before = routingEvidenceIds()

    expect(resolveRootFromLastTurn(db(), root)).toBe(0)
    expect(db().query('SELECT status FROM run WHERE id=?').get(root))
      .toEqual({ status: 'asking' })
    expect(routingEvidenceIds()).toEqual(before)
  })

  test('a recoverable root whose last turn is still asking is not ended', () => {
    const root = addRun({ agent: 'grok', job: 'implement', status: 'asking' })
    db().query(
      `INSERT INTO question (run_id, asked_at, question, answer, answered_at)
       VALUES (?,?,?,?,?)`,
    ).run(root, nowIso(), 'answered, not continued', 'the ruling', nowIso())
    addRun({
      agent: 'grok', job: 'implement', status: 'asking', parent: root, turn: 2,
    })
    const before = routingEvidenceIds()

    expect(resolveRootFromLastTurn(db(), root)).toBe(0)
    expect(db().query('SELECT status FROM run WHERE id=?').get(root))
      .toEqual({ status: 'asking' })
    expect(routingEvidenceIds()).toEqual(before)
  })

  test('a root whose newest turn is still running is not ended', () => {
    const root = addRun({ agent: 'grok', job: 'implement', status: 'asking' })
    db().query(
      `INSERT INTO question (run_id, asked_at, question, answer, answered_at)
       VALUES (?,?,?,?,?)`,
    ).run(root, nowIso(), 'answered', 'the ruling', nowIso())
    addRun({
      agent: 'grok', job: 'implement', status: 'running', parent: root, turn: 2,
    })

    expect(resolveRootFromLastTurn(db(), root)).toBe(0)
    expect(db().query('SELECT status FROM run WHERE id=?').get(root))
      .toEqual({ status: 'asking' })
  })

  test('a plain failed turn inherits its terminal status and failure kind', () => {
    const failed = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    db().query(
      `INSERT INTO question (run_id, asked_at, question, answer, answered_at)
       VALUES (?,?,?,?,?)`,
    ).run(failed, nowIso(), 'which way?', 'that way', nowIso())
    addRun({
      agent: 'codex', job: 'implement', status: 'failed', parent: failed, turn: 2, kind: 'timeout',
    })
    expect(resolveRootFromLastTurn(db(), failed)).toBe(1)
    expect(db().query('SELECT status, failure_kind FROM run WHERE id=?').get(failed))
      .toEqual({ status: 'failed', failure_kind: 'timeout' })

    const succeeded = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    db().query(
      `INSERT INTO question (run_id, asked_at, question, answer, answered_at)
       VALUES (?,?,?,?,?)`,
    ).run(succeeded, nowIso(), 'which way?', 'that way', nowIso())
    addRun({ agent: 'codex', job: 'implement', status: 'ok', parent: succeeded, turn: 2 })
    expect(resolveRootFromLastTurn(db(), succeeded)).toBe(1)
    expect(db().query('SELECT status FROM run WHERE id=?').get(succeeded))
      .toEqual({ status: 'ok' })
  })

  test('a resumed truncation rolls up through run and stays excluded', async () => {
    const root = addRun({ agent: 'grok', job: 'understand', status: 'asking' })
    const before = candidates('understand').find((row) => row.agent === 'grok')!
    expect(before.evidence).toBe(0)

    const outcome = await resumeWithGrok(root, [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'truncated-resume' }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'thinking', text: 'the findings survived in the transcript' }],
          stop_reason: 'max_tokens',
        },
      }),
      JSON.stringify({
        type: 'result', subtype: 'error_during_execution', result: '', stop_reason: 'max_tokens',
        errors: ['response truncated by max_tokens'],
      }),
    ].join('\n') + '\n')
    expect(outcome.error?.message).toContain('response truncated at output ceiling (max_tokens)')
    expect(db().query(
      'SELECT status, error, failure_kind FROM run WHERE id=?',
    ).get(root)).toEqual({
      status: 'failed', error: 'response truncated at output ceiling (max_tokens)',
      failure_kind: 'truncated',
    })
    const after = candidates('understand').find((row) => row.agent === 'grok')!
    expect(after.evidence).toBe(before.evidence)
    expect(after.failures).toBe(before.failures)
  })

  test('a resumed quota failure rolls up through run and stays excluded', async () => {
    const root = addRun({ agent: 'grok', job: 'understand', status: 'asking' })
    const before = candidates('understand').find((row) => row.agent === 'grok')!

    const outcome = await resumeWithGrok(root, JSON.stringify({
      type: 'result', subtype: 'error_during_execution', errors: ['HTTP 402: no balance'],
    }) + '\n')
    expect(outcome.error?.message).toContain('HTTP 402: no balance')
    expect(db().query(
      'SELECT status, error, failure_kind FROM run WHERE id=?',
    ).get(root)).toEqual({
      status: 'failed', error: expect.stringContaining('HTTP 402: no balance'), failure_kind: 'quota',
    })
    const child = db().query(
      'SELECT id FROM run WHERE parent_run_id=?',
    ).get(root) as { id: number }
    expect(db().query(
      'SELECT resource_kind, event_kind, resource_key, run_id FROM contention WHERE run_id=?',
    ).get(child.id)).toEqual({
      resource_kind: 'vendor', event_kind: 'refusal', resource_key: 'grok', run_id: child.id,
    })
    const after = candidates('understand').find((row) => row.agent === 'grok')!
    expect(after.evidence).toBe(before.evidence)
    expect(after.failures).toBe(before.failures)
  })

  test('a dropped contention table does not roll back a terminal run', async () => {
    const table = db().query(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='contention'",
    ).get() as { sql: string }
    const indexes = db().query(
      "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='contention' AND sql IS NOT NULL",
    ).all() as { sql: string }[]
    db().exec('DROP TABLE contention')
    try {
      const root = addRun({ agent: 'grok', job: 'understand', status: 'asking' })
      const outcome = await resumeWithGrok(root, JSON.stringify({
        type: 'result', subtype: 'error_during_execution', errors: ['HTTP 402: no balance'],
      }) + '\n')
      expect(outcome.error?.message).toContain('HTTP 402: no balance')
      expect(db().query(
        'SELECT status, failure_kind FROM run WHERE id=?',
      ).get(root)).toEqual({ status: 'failed', failure_kind: 'quota' })
    } finally {
      db().exec(table.sql)
      for (const index of indexes) db().exec(index.sql)
    }
  })

  test('a successful resumed turn clears an earlier timeout from the root', async () => {
    const root = addRun({ agent: 'grok', job: 'understand', status: 'failed', kind: 'timeout' })
    db().query("UPDATE run SET error='timed out' WHERE id=?").run(root)
    score(root, 'full', 'right')

    const outcome = await resumeWithGrok(root, JSON.stringify({
      type: 'result', subtype: 'success', result: 'finished after resuming',
    }) + '\n')
    expect(outcome.error).toBeNull()
    expect(outcome.result?.status).toBe('ok')
    expect(db().query(
      'SELECT status, error, failure_kind FROM run WHERE id=?',
    ).get(root)).toEqual({ status: 'ok', error: null, failure_kind: null })
    expect(routingEvidenceIds()).toContain(root)
    expect(candidates('understand').find((row) => row.agent === 'grok')!.evidence).toBe(1)
  })

  test('turns of one run do not each count as evidence', () => {
    // A worker that asked two questions produces three rows. Counting each
    // would let an agent reach MIN_SAMPLE by being inquisitive rather than good.
    const root = addRun({ agent: 'codex', job: 'implement' })
    addRun({ agent: 'codex', job: 'implement', parent: root, turn: 2 })
    addRun({ agent: 'codex', job: 'implement', parent: root, turn: 3 })
    score(root, 'full', 'right')

    const c = candidates('implement').find((x) => x.agent === 'codex')!
    expect(c.runs).toBe(1)      // one unit of work
    expect(c.evidence).toBe(1)  // one judgement, not three
    expect(c.score).toBe(weigh('full', 'right'))
  })

  test('a child turn is never offered for scoring', () => {
    const root = addRun({ agent: 'codex', job: 'implement', session: 's1' })
    const child = addRun({ agent: 'codex', job: 'implement', parent: root, turn: 2, session: 's1' })
    const ids = pendingForSession('s1').map((r) => r.id)
    expect(ids).toContain(root)
    expect(ids).not.toContain(child)
  })

  test('a root is not offered while its newest turn is still running', () => {
    const root = addRun({ agent: 'codex', job: 'implement', session: 's1' })
    const child = addRun({
      agent: 'codex', job: 'implement', status: 'running', parent: root, turn: 2, session: 's1',
    })
    expect(pendingForSession('s1')).toHaveLength(0)
    expect(unscoredCount()).toBe(0)

    db().query("UPDATE run SET status='ok' WHERE id=?").run(child)
    expect(pendingForSession('s1').map((r) => r.id)).toEqual([root])
    expect(unscoredCount()).toBe(1)
  })
})

describe('read-only orchestrator database', () => {
  const CLI = new URL('cli.ts', import.meta.url).pathname

  const fixture = (withHeartbeat = true) => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'orch-readonly-'))
    const path = join(fixtureDir, 'orch.db')
    const d = new Database(path)
    applySchema(d)
    if (!withHeartbeat) d.exec('DROP TABLE session_seen')
    d.close()
    return { fixtureDir, path }
  }

  const invoke = (path: string, command: string | readonly string[]) => Bun.spawnSync(
    [process.execPath, CLI, ...(Array.isArray(command) ? command : [command])],
    {
      env: {
        ...process.env,
        ORCH_DB: path,
        ORCH_DEPTH: '0',
        CLAUDE_CODE_SESSION_ID: 'read-only-test-session',
      },
      stdout: 'pipe', stderr: 'pipe',
    },
  )

  test('jobs and inbox serve reads without stamping a chmod-444 database', () => {
    const { fixtureDir, path } = fixture()
    chmodSync(path, 0o444)
    try {
      for (const command of ['jobs', 'inbox', ['review', 'list', '--json'], ['review', 'calibration', '--json']] as const) {
        const p = invoke(path, command)
        expect(p.exitCode, `${JSON.stringify(command)}: ${p.stderr.toString()}`).toBe(0)
        expect(p.stderr.toString()).toBe('')
      }
      const readonly = new Database(path, { readonly: true })
      expect(readonly.query('SELECT COUNT(*) n FROM session_seen').get()).toEqual({ n: 0 })
      readonly.close()
    } finally {
      chmodSync(path, 0o644)
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  }, 20_000)

  test('a read-only database missing session_seen still serves jobs and inbox', () => {
    const { fixtureDir, path } = fixture(false)
    chmodSync(path, 0o444)
    try {
      for (const command of ['jobs', 'inbox', ['review', 'list', '--json'], ['review', 'calibration', '--json']] as const) {
        const p = invoke(path, command)
        expect(p.exitCode, `${JSON.stringify(command)}: ${p.stderr.toString()}`).toBe(0)
        expect(p.stderr.toString()).toBe('')
      }
      const readonly = new Database(path, { readonly: true })
      expect(readonly.query(
        `SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_seen'`,
      ).get()).toBeNull()
      readonly.close()
    } finally {
      chmodSync(path, 0o644)
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  }, 20_000)

  test('a writable database keeps stamping the current session', () => {
    const { fixtureDir, path } = fixture()
    try {
      for (const command of ['jobs', 'inbox'] as const) {
        const p = invoke(path, command)
        expect(p.exitCode).toBe(0)
        expect(p.stderr.toString()).toBe('')
      }
      const writable = new Database(path)
      expect(writable.query(
        'SELECT session_id FROM session_seen WHERE session_id=?',
      ).get('read-only-test-session')).toEqual({ session_id: 'read-only-test-session' })
      writable.close()
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  })

  test('coverage audit leaves the database bytes unchanged and creates no WAL', () => {
    const { fixtureDir, path } = fixture()
    const digest = () => createHash('sha256').update(readFileSync(path)).digest('hex')
    const before = digest()
    try {
      expect(existsSync(`${path}-wal`)).toBe(false)
      const p = Bun.spawnSync([process.execPath, CLI, 'review', 'coverage-audit', '--json'], {
        env: { ...process.env, ORCH_DB: path, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(p.stderr.toString()).toBe('')
      expect(JSON.parse(p.stdout.toString())).toEqual({
        count: 0, review_ids: [], partial_review_ids: [],
      })
      expect(digest()).toBe(before)
      expect(existsSync(`${path}-wal`)).toBe(false)
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  })

  test('a failed heartbeat stamp never propagates', () => {
    db().exec('DROP TABLE session_seen')
    try {
      expect(() => recordSessionSeen('heartbeat-failure-test')).not.toThrow()
    } finally {
      db().exec(`CREATE TABLE session_seen (
        session_id TEXT PRIMARY KEY,
        last_seen TEXT NOT NULL
      )`)
    }
  })
})
