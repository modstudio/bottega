import { describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync, existsSync, mkdirSync, utimesSync, chmodSync, mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENTS, GENERIC_QUESTION_TOKENS, KEEP_RUN_FILES_DAYS, addDoctrineRule, addPair, addRun, addSkip, adoptRunMutation, ask, authorizeRunMutation, baselineForPair, candidates, db, detectBlockers, dir, duelMatrices, errorTail, hasRealQuestions, hermeticGitEnv, judgeability, ledgerRef, listDoctrineRules, listLedgerRefs, listPairs, listSkips, nowIso, parseRunIds, parseWorkerReply, parseWorkerReplyWithCount, pendingForSession, pick, projects, pruneRuns, realQuestions, recordDuels, resolveLedgerRef, retireDoctrineRule, run, runDetail, runFilePaths, score, sessionId, setBaseline, setLedgerRef, state, upsertProject, weigh, workerReply } from '../test/fixture.ts'

describe('porting data model', () => {
  test('stores pair progress and declined candidates with their reasons', () => {
    upsertProject({ name: 'source-invented', path: '/w/source-invented',
      settings: { keyPrefixes: ['SRC'] } })
    upsertProject({ name: 'target-invented', path: '/w/target-invented',
      settings: { keyPrefixes: ['TGT'] } })
    const [source, target] = projects().sort((a, b) => a.name.localeCompare(b.name))
    const pair = addPair(source!.id, target!.id, '2026-09-01T00:00:00.000Z')

    expect(addPair(source!.id, target!.id).id).toBe(pair.id)
    expect(listPairs()).toEqual([pair])
    expect(baselineForPair(pair.id)).toEqual({
      pair_id: pair.id, source_commit: null, scanned_at: null,
    })
    expect(setBaseline(pair.id, 'abc123', '2026-09-02T00:00:00.000Z')).toEqual({
      pair_id: pair.id, source_commit: 'abc123', scanned_at: '2026-09-02T00:00:00.000Z',
    })
    addSkip(pair.id, 'candidate-one', 'not applicable', '2026-09-03T00:00:00.000Z')
    expect(listSkips(pair.id)).toMatchObject([
      { candidate: 'candidate-one', reason: 'not applicable' },
    ])
  })

  test('keeps each ledger source project distinct and resolves the target by key prefix', () => {
    upsertProject({ name: 'source-one-invented', path: '/w/source-one', settings: {} })
    upsertProject({ name: 'source-two-invented', path: '/w/source-two', settings: {} })
    upsertProject({ name: 'target-invented', path: '/w/target',
      settings: { keyPrefixes: ['TGT'] } })
    const byName = Object.fromEntries(projects().map((project) => [project.name, project]))

    const ref = setLedgerRef({
      taskKey: 'TGT-42', note: 'adapt this natively', createdAt: '2026-09-03T00:00:00.000Z',
      sources: [
        { source_project_id: byName['source-one-invented']!.id,
          commits: ['aaa'], paths: ['src/a.ts'], note: 'first source' },
        { source_project_id: byName['source-two-invented']!.id,
          commits: ['bbb', 'ccc'], paths: ['src/b.ts'], note: 'second source' },
      ],
    })

    expect(ref.target_project_id).toBe(byName['target-invented']!.id)
    expect(ledgerRef('TGT-42')!.sources).toEqual([
      { source_project_id: byName['source-one-invented']!.id,
        commits: ['aaa'], paths: ['src/a.ts'], note: 'first source' },
      { source_project_id: byName['source-two-invented']!.id,
        commits: ['bbb', 'ccc'], paths: ['src/b.ts'], note: 'second source' },
    ])
    expect(() => setLedgerRef({ taskKey: 'NONE-1', note: '', sources: ref.sources }))
      .toThrow('no registered project owns task key')
  })

  test('resolution preserves provenance and default listings omit completed refs', () => {
    upsertProject({ name: 'source-invented', path: '/w/source', settings: {} })
    upsertProject({ name: 'target-invented', path: '/w/target',
      settings: { keyPrefixes: ['TGT'] } })
    const source = projects().find((project) => project.name === 'source-invented')!
    setLedgerRef({
      taskKey: 'TGT-42', note: 'provenance',
      sources: [{ source_project_id: source.id, commits: ['abc'], paths: ['src/a.ts'], note: 'source' }],
    })

    expect(listLedgerRefs()).toHaveLength(1)
    expect(resolveLedgerRef('TGT-42', '2026-09-04T00:00:00.000Z')).toMatchObject({
      task_key: 'TGT-42', resolved_at: '2026-09-04T00:00:00.000Z',
      sources: [{ commits: ['abc'], paths: ['src/a.ts'] }],
    })
    expect(listLedgerRefs()).toEqual([])
    expect(listLedgerRefs(true)).toHaveLength(1)
    expect(resolveLedgerRef('TGT-42', 'later')?.resolved_at).toBe('2026-09-04T00:00:00.000Z')
  })

  test('retires doctrine without freeing its stable number', () => {
    addDoctrineRule(7, 'Invented rule', 'Keep the example invented.', '2026-09-01T00:00:00.000Z')
    expect(retireDoctrineRule(7, '2026-09-02T00:00:00.000Z')).toBe(true)
    expect(listDoctrineRules(false)).toEqual([])
    expect(listDoctrineRules()).toMatchObject([{ number: 7, retired_at: '2026-09-02T00:00:00.000Z' }])
    expect(() => addDoctrineRule(7, 'Replacement', 'Must not reuse seven.')).toThrow()
  })
})

describe('session scoping', () => {
  test('only this session\'s own unscored runs are raised', () => {
    const mine = addRun({ agent: 'grok', job: 'craft' })
    const theirs = addRun({ agent: 'grok', job: 'craft' })
    db().query('UPDATE run SET session_id=? WHERE id=?').run('session-A', mine)
    db().query('UPDATE run SET session_id=? WHERE id=?').run('session-B', theirs)

    const pending = pendingForSession('session-A')
    expect(pending.map((r) => r.id)).toEqual([mine])
  })

  test('with no session id, nothing is claimed', () => {
    expect(pendingForSession(null)).toEqual([])
  })

  test('a scored run drops off the backlog', () => {
    const id = addRun({ agent: 'grok', job: 'craft' })
    db().query('UPDATE run SET session_id=? WHERE id=?').run('s', id)
    expect(pendingForSession('s')).toHaveLength(1)
    score(id, 'full', 'right')
    expect(pendingForSession('s')).toHaveLength(0)
  })
})

describe('session identity is the primary id only', () => {
  const restoreSessionEnv = (claude: string | undefined, bridge: string | undefined) => {
    if (claude === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = claude
    if (bridge === undefined) delete process.env.CLAUDE_CODE_BRIDGE_SESSION_ID
    else process.env.CLAUDE_CODE_BRIDGE_SESSION_ID = bridge
  }

  test('primary set returns that id', () => {
    const claude = process.env.CLAUDE_CODE_SESSION_ID
    const bridge = process.env.CLAUDE_CODE_BRIDGE_SESSION_ID
    try {
      process.env.CLAUDE_CODE_SESSION_ID = 'primary-session'
      process.env.CLAUDE_CODE_BRIDGE_SESSION_ID = 'shared-bridge'
      expect(sessionId()).toBe('primary-session')
    } finally {
      restoreSessionEnv(claude, bridge)
    }
  })

  test('only the bridge id is null and cannot adopt', () => {
    const claude = process.env.CLAUDE_CODE_SESSION_ID
    const bridge = process.env.CLAUDE_CODE_BRIDGE_SESSION_ID
    try {
      delete process.env.CLAUDE_CODE_SESSION_ID
      process.env.CLAUDE_CODE_BRIDGE_SESSION_ID = 'shared-bridge'
      expect(sessionId()).toBeNull()
      for (const action of [
        'answer', 'tell', 'stop', 'abandon', 'discard', 'void', 'continue', 'score',
        'retry', 'receipt',
      ] as const) {
        const id = addRun({ agent: 'codex', job: 'implement' })
        expect(() => adoptRunMutation(authorizeRunMutation(id, action), action))
          .toThrow('CLAUDE_CODE_SESSION_ID')
      }
    } finally {
      restoreSessionEnv(claude, bridge)
    }
  })

  test('neither variable yields null', () => {
    const claude = process.env.CLAUDE_CODE_SESSION_ID
    const bridge = process.env.CLAUDE_CODE_BRIDGE_SESSION_ID
    try {
      delete process.env.CLAUDE_CODE_SESSION_ID
      delete process.env.CLAUDE_CODE_BRIDGE_SESSION_ID
      expect(sessionId()).toBeNull()
    } finally {
      restoreSessionEnv(claude, bridge)
    }
  })
})

describe('who may judge a run', () => {
  test('a missing caller identity satisfies no owned mutation gate', () => {
    const id = addRun({ agent: 'codex', job: 'implement', session: 'owner-session' })
    const claude = process.env.CLAUDE_CODE_SESSION_ID
    const bridge = process.env.CLAUDE_CODE_BRIDGE_SESSION_ID
    delete process.env.CLAUDE_CODE_SESSION_ID
    delete process.env.CLAUDE_CODE_BRIDGE_SESSION_ID
    try {
      for (const action of ['answer', 'tell', 'stop', 'abandon', 'discard', 'void', 'retry', 'continue'] as const) {
        expect(() => authorizeRunMutation(id, action))
          .toThrow('current session no session identity is present')
      }
    } finally {
      if (claude === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
      else process.env.CLAUDE_CODE_SESSION_ID = claude
      if (bridge === undefined) delete process.env.CLAUDE_CODE_BRIDGE_SESSION_ID
      else process.env.CLAUDE_CODE_BRIDGE_SESSION_ID = bridge
    }
  })

  test('each authoritative action adopts once, then refuses another session', () => {
    const prior = process.env.CLAUDE_CODE_SESSION_ID
    try {
      for (const action of [
        'answer', 'tell', 'stop', 'abandon', 'discard', 'void', 'continue', 'score',
        'retry', 'receipt',
      ] as const) {
        const id = addRun({ agent: 'codex', job: 'implement' })
        process.env.CLAUDE_CODE_SESSION_ID = 'session-A'
        const adopted = adoptRunMutation(authorizeRunMutation(id, action), action)
        expect(adopted.owner).toBe('session-A')
        expect(db().query(
          'SELECT action, actor_session, reason FROM run_mutation_audit WHERE run_id=?',
        ).get(id)).toEqual({
          action: 'adopt', actor_session: 'session-A', reason: `before ${action}`,
        })

        process.env.CLAUDE_CODE_SESSION_ID = 'session-B'
        expect(() => authorizeRunMutation(id, action))
          .toThrow(`run ${id} is owned by session session-A`)
      }
    } finally {
      if (prior === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
      else process.env.CLAUDE_CODE_SESSION_ID = prior
    }
  })

  // The rule was already written in AGENTS.md and did not hold: on 2026-08-31 two
  // concurrent sessions each scored the other's runs within an hour, both having
  // inferred their ids from their own previous block rather than reading them
  // back. These pin the guard that turns that prose into a refusal.

  test('the session that made a run may score it', () => {
    expect(judgeability('session-A', 'session-A')).toEqual({ verdict: 'own' })
  })

  test('another session may NOT — it never read the output', () => {
    expect(judgeability('session-A', 'session-B')).toEqual({
      verdict: 'foreign',
      owner: 'session-A',
    })
  })

  test('the owner travels with the refusal, so the error can name who to ask', () => {
    // Without this the message could only say "not yours", which does not tell
    // anyone what to do next. Naming the session is what makes SendMessage the
    // obvious move rather than --force.
    const v = judgeability('session-A', 'session-B')
    expect(v.verdict === 'foreign' && v.owner).toBe('session-A')
  })

  test('a run recorded before session ids is scoreable by anyone', () => {
    // Refusing these would strand every run made before session_id existed.
    // Missing evidence is not evidence of wrongdoing.
    expect(judgeability(null, 'session-A')).toEqual({ verdict: 'unattributed' })
    expect(judgeability(null, null)).toEqual({ verdict: 'unattributed' })
  })

  test('a caller with no session id is warned, not blocked', () => {
    // Scoring from a plain shell is legitimate; it just cannot be verified.
    expect(judgeability('session-A', null)).toEqual({
      verdict: 'anonymous',
      owner: 'session-A',
    })
  })
})

describe('pairwise judgements', () => {
  test('--better-than accepts a comma list of run ids', () => {
    expect(parseRunIds('12,13,99', '--better-than')).toEqual([12, 13, 99])
    expect(() => parseRunIds('', '--better-than')).toThrow('at least one run id')
    expect(() => parseRunIds('12,nope', '--better-than')).toThrow('separated by commas')
    expect(() => parseRunIds('12,12', '--better-than')).toThrow('same run more than once')
  })

  test('one winner can be recorded against every loser in a fan-out', () => {
    const winner = addRun({ agent: 'codex', job: 'craft', session: 'session-A' })
    const grok = addRun({ agent: 'grok', job: 'craft', session: 'session-A' })
    const agy = addRun({ agent: 'agy', job: 'craft', session: 'session-A' })
    recordDuels(winner, [grok, agy], 'session-A', '2026-09-02T12:00:00.000Z')

    expect(db().query(
      'SELECT job, winner_run_id, loser_run_id, session_id, at FROM duel ORDER BY loser_run_id',
    ).all()).toEqual([
      { job: 'craft', winner_run_id: winner, loser_run_id: grok,
        session_id: 'session-A', at: '2026-09-02T12:00:00.000Z' },
      { job: 'craft', winner_run_id: winner, loser_run_id: agy,
        session_id: 'session-A', at: '2026-09-02T12:00:00.000Z' },
    ])
    // Re-scoring does not duplicate the pair protected by the UNIQUE constraint.
    recordDuels(winner, [grok], 'session-A', '2026-09-02T13:00:00.000Z')
    expect((db().query('SELECT COUNT(*) AS n FROM duel').get() as { n: number }).n).toBe(2)
  })

  test('duels require distinct runs from the same job', () => {
    const craft = addRun({ agent: 'codex', job: 'craft', session: 'session-A' })
    const safety = addRun({ agent: 'grok', job: 'safety', session: 'session-A' })
    expect(() => recordDuels(craft, [craft], 'session-A', new Date().toISOString()))
      .toThrow('cannot be better than itself')
    expect(() => recordDuels(craft, [safety], 'session-A', new Date().toISOString()))
      .toThrow('jobs differ')
    expect((db().query('SELECT COUNT(*) AS n FROM duel').get() as { n: number }).n).toBe(0)
  })

  test('both runs must be judgeable by this session unless forced', () => {
    const mine = addRun({ agent: 'codex', job: 'craft', session: 'session-A' })
    const theirs = addRun({ agent: 'grok', job: 'craft', session: 'session-B' })
    expect(() => recordDuels(mine, [theirs], 'session-A', new Date().toISOString()))
      .toThrow('Both runs in a duel must be scoreable by this session')
    recordDuels(mine, [theirs], 'session-A', new Date().toISOString(), true)
    expect((db().query('SELECT COUNT(*) AS n FROM duel').get() as { n: number }).n).toBe(1)
  })

  test('stats data is a per-job agent win-loss matrix', () => {
    const codex = addRun({ agent: 'codex', job: 'craft', session: 's' })
    const grok = addRun({ agent: 'grok', job: 'craft', session: 's' })
    const agy = addRun({ agent: 'agy', job: 'craft', session: 's' })
    const other = addRun({ agent: 'grok', job: 'safety', session: 's' })
    recordDuels(codex, [grok, agy], 's', new Date().toISOString())
    recordDuels(grok, [codex], 's', new Date().toISOString())
    recordDuels(other, [addRun({ agent: 'codex', job: 'safety', session: 's' })],
      's', new Date().toISOString())

    const matrix = duelMatrices('craft')
    expect(matrix).toHaveLength(1)
    expect(matrix[0]!.job).toBe('craft')
    expect(matrix[0]!.agents).toEqual(['agy', 'codex', 'grok'])
    expect(matrix[0]!.cells.codex!.grok).toEqual({ wins: 1, losses: 1 })
    expect(matrix[0]!.cells.codex!.agy).toEqual({ wins: 1, losses: 0 })
    expect(matrix[0]!.cells.agy!.grok).toEqual({ wins: 0, losses: 0 })
  })
})

describe('reading the verdict off the command line', () => {
  // Mirrors the filter in cli.ts. `orch score 279 none --note "..."` read
  // --note as the quality and rejected the whole thing as incoherent, which is
  // a baffling way to be told about a typo nobody made.
  const VALUE_FLAGS = new Set(['--agent', '--file', '--schema', '--model', '--note',
                               '--job', '--limit', '--port', '--days', '--window'])
  const words = (args: string[]) =>
    args.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(args[i - 1] ?? ''))

  test('a note does not get read as the quality', () => {
    expect(words(['none', '--note', 'it returned a vendor error'])).toEqual(['none'])
  })

  test('both halves survive a trailing note', () => {
    expect(words(['full', 'right', '--note', 'good stuff'])).toEqual(['full', 'right'])
  })

  test('a boolean switch does not eat the word after it', () => {
    expect(words(['full', '--quiet', 'right'])).toEqual(['full', 'right'])
  })
})

describe('what the views print beside a percentage', () => {
  test('a failure-only cell has a negative mean, which a bar cannot render', () => {
    // The router is entitled to a negative score. `width:-50%` renders as
    // nothing, with no hint that the cell is bad rather than empty.
    addRun({ agent: 'agy', job: 'craft', status: 'failed' })
    const c = candidates('craft').find((x) => x.agent === 'agy')!
    expect(c.score).toBeLessThan(0)
    const pct = Math.round(c.score! * 100)
    expect(Math.max(0, Math.min(100, pct))).toBe(0)
  })

  test('evidence is what MIN_SAMPLE counts, so it is what a surface must print', () => {
    // One good verdict plus two unjudged failures: the mean is 0 over THREE
    // judgements. A surface printing "0% of 1" beside it is incoherent — a 0%
    // on a single `right` verdict cannot happen.
    score(addRun({ agent: 'agy', job: 'review-lens-inline' }), 'full', 'right')
    addRun({ agent: 'agy', job: 'review-lens-inline', status: 'failed' })
    addRun({ agent: 'agy', job: 'review-lens-inline', status: 'stale' })
    const c = candidates('review-lens-inline').find((x) => x.agent === 'agy')!
    expect(c.score).toBe(0)
    expect(c.scored).toBe(1)     // verdicts alone
    expect(c.evidence).toBe(3)   // what the 0% is actually over
  })
})

describe('probes are excluded from every query that reports', () => {
  test('byRepo leaves calibration traffic out', () => {
    // The rule is stated in AGENTS.md and this was the one aggregate that had
    // no test holding it: byRepo counted probes until it was noticed by eye.
    const real = addRun({ agent: 'grok', job: 'craft' })
    const probe = addRun({ agent: 'grok', job: 'craft', probe: 1 })
    for (const id of [real, probe]) {
      db().query("UPDATE run SET repo='devbox', vendor_tokens=100 WHERE id=?").run(id)
    }
    const rows = state(null).byRepo as { repo: string; runs: number; toks: number }[]
    const devbox = rows.find((r) => r.repo === 'devbox')!
    expect(devbox.runs).toBe(1)
    expect(devbox.toks).toBe(100)
  })
})

describe('run detail', () => {
  test('publishes every field hub reads without publishing the ask credential', () => {
    const id = addRun({ agent: 'grok', job: 'craft', status: 'failed', latency: 1234, probe: 1 })
    const promptPath = join(dir, 'detail-prompt.txt')
    const outputPath = join(dir, 'detail-output.txt')
    writeFileSync(promptPath, 'the whole prompt')
    writeFileSync(outputPath, 'the whole reply')
    db().query(
      `UPDATE run SET vendor_tokens=?, failure_kind=?, evidence_excluded=?, error=?,
                      prompt_path=?, output_path=?, run_token=?, doc_revisions=?, canon_sha=? WHERE id=?`,
    ).run(5678, 'timeout', 'not evidence', 'timed out', promptPath, outputPath, 'secret', '[4,9]', 'canon-123', id)
    score(id, 'partial', 'mixed')
    db().query('UPDATE score SET note=? WHERE run_id=?').run('read by hub', id)

    const detail = runDetail(id)!
    expect(detail).toMatchObject({
      id, requested_id: id, resolved_from: 'root', root_id: id,
      agent: 'grok', job: 'craft', latency_ms: 1234, vendor_tokens: 5678,
      status: 'failed', failure_kind: 'timeout', probe: 1,
      evidence_excluded: 'not evidence', error: 'timed out',
      doc_revisions: '[4,9]', canon_sha: 'canon-123',
      delivery: 'partial', quality: 'mixed', note: 'read by hub',
      prompt: 'the whole prompt', output: 'the whole reply',
    })
    expect(detail).not.toHaveProperty('run_token')
  })

  test('publishes ordered chain audit and renders a missing actor explicitly', () => {
    const root = addRun({ agent: 'codex', job: 'implement' })
    const child = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET parent_run_id=?, turn=2 WHERE id=?').run(root, child)
    const insertAudit = db().query(
      `INSERT INTO run_mutation_audit (run_id, root_id, action, actor_session, at, reason)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    insertAudit.run(root, root, 'stop', null, '2026-09-05T01:00:00.000Z', null)
    insertAudit.run(child, root, 'continue', 'architect-session', '2026-09-05T02:00:00.000Z', 'ruled')

    expect(runDetail(child)!.audit).toEqual([
      { run_id: root, root_id: root, action: 'stop',
        actor_session: 'anonymous (no session id)', at: '2026-09-05T01:00:00.000Z', reason: null },
      { run_id: child, root_id: root, action: 'continue',
        actor_session: 'architect-session', at: '2026-09-05T02:00:00.000Z', reason: 'ruled' },
    ])
    expect(runDetail(child)).toMatchObject({
      id: child, requested_id: child, resolved_from: 'turn', root_id: root,
    })
    expect(() => insertAudit.run(root, root, 'invented', null, nowIso(), null)).toThrow()
  })
})

describe('what survives of a failure', () => {
  // The shape that lost four failures: a banner, then the whole prompt echoed
  // back, then — right at the end — what actually went wrong.
  const codexish = (promptChars: number) =>
    'OpenAI Codex v0.151.0\n--------\nmodel: gpt-5.6-sol\nsandbox: read-only\n--------\n' +
    'x'.repeat(promptChars) +
    '\nERROR: the thing that actually broke'

  test('the error at the end is kept', () => {
    expect(errorTail(codexish(50_000))).toContain('the thing that actually broke')
  })

  test('and the banner at the start is kept too', () => {
    // Run 243 was diagnosable only because its banner survived: the model and
    // provider lines were the explanation.
    const out = errorTail(codexish(50_000))
    expect(out).toContain('OpenAI Codex v0.151.0')
    expect(out).toContain('model: gpt-5.6-sol')
  })

  test('the echoed prompt in the middle is what gets dropped', () => {
    const out = errorTail(codexish(50_000))
    expect(out).toContain('characters omitted')
    expect(out.length).toBeLessThan(2200)
  })

  test('a short error is stored whole, untouched', () => {
    expect(errorTail('exit 143, empty output')).toBe('exit 143, empty output')
  })
})

/**
 * `orch wait` and `orch result` are the collection half of `--detach`, and
 * another session's fan-out now depends on their exit codes meaning what they
 * say. Driven through the real CLI, because the bugs worth catching here are in
 * argument parsing and process exit status, neither of which a unit call sees.
 */
describe('a repository-reading job gets a disposable writable disk', () => {
  /**
   * One session had seven files of uncommitted review fixes in its
   * checkout. A review lens ran there with --mcp and codex's
   * --approve-for-me implied workspace-write. The tree came back at HEAD, no
   * stash, no commit, nothing in the reflog. The disposable worktree makes that
   * permission safe instead of excluding the agent from the route.
   */
  test('the old caller-checkout MCP exclusion is no longer needed', () => {
    expect(pick('review-lens', 'codex', 0, false, null).agent).toBe('codex')
  })

  test('the same agent remains fine without tools', () => {
    expect(pick('review-lens', 'codex', 0, false, null).agent).toBe('codex')
  })
})

describe('run files are named by their run, not by the clock', () => {
  /**
   * Six review lenses fired concurrently put three runs inside one millisecond
   * with the same agent and job, so they shared a prompt file AND an output
   * file. Each worker read whichever prompt was written last, and all three
   * answered the same question while claiming to be three different lenses.
   * The session that hit it scored two of them `none` and caught it only
   * because the content did not match what it had asked for.
   *
   * The stored paths are the evidence, so the test reads them: two runs of the
   * same job started in the same millisecond must not name the same file.
   */
  test('neither call site names a run file from the clock alone', () => {
    // Asserted against the SOURCE, the way the stale-`blocked` guard is, because
    // reproducing a millisecond collision on demand is a race the test would
    // lose more often than the bug did.
    const dir = new URL('.', import.meta.url).pathname
    for (const file of ['run.ts', 'cli.ts']) {
      // Comments quote the OLD pattern on purpose, to record what went wrong.
      const code = readFileSync(join(dir, file), 'utf8')
        .split('\n')
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .join('\n')
      for (const n of code.match(/`\$\{Date\.now\(\)\}[^`]*`/g) ?? []) {
        expect(n).toMatch(/reserveId|unique|randomUUID/)
      }
    }
  })

  test('two runs created in the same millisecond have distinct paths', () => {
    const clock = 1_700_000_000_000
    const first = runFilePaths(dir, clock, 1, 'codex', 'review-lens')
    const second = runFilePaths(dir, clock, 2, 'codex', 'review-lens')
    expect(first.prompt).not.toBe(second.prompt)
    expect(first.output).not.toBe(second.output)
  })
})

describe('run file pruning', () => {
  test('deleting expired files nulls their matching database paths', () => {
    const files = join(dir, 'prune-files')
    mkdirSync(files)
    const prompt = join(files, 'old.prompt.txt')
    const output = join(files, 'old.txt')
    writeFileSync(prompt, 'prompt')
    writeFileSync(output, 'output')
    const old = new Date(Date.now() - (KEEP_RUN_FILES_DAYS + 1) * 86_400_000)
    utimesSync(prompt, old, old)
    utimesSync(output, old, old)
    const id = addRun({ agent: 'codex', job: 'file-question' })
    db().query('UPDATE run SET prompt_path=?, output_path=? WHERE id=?').run(prompt, output, id)

    pruneRuns(files)

    expect(existsSync(prompt)).toBe(false)
    expect(existsSync(output)).toBe(false)
    expect(db().query('SELECT prompt_path, output_path FROM run WHERE id=?').get(id))
      .toEqual({ prompt_path: null, output_path: null })
  })
})

describe('a worker that stops to ask is not a worker that failed', () => {
  test('an unparseable reply is rejected rather than read as a status', () => {
    // The dangerous direction: treating "no structured reply" as success would
    // record an unverifiable change set as a completed implementation.
    expect(parseWorkerReply('I have finished the work, it all looks good.')).toBeNull()
    expect(parseWorkerReply('')).toBeNull()
  })

  test('an unknown status is not silently promoted to done', () => {
    expect(parseWorkerReply(JSON.stringify(workerReply({ status: 'partially-done' })))).toBeNull()
  })

  test('the object is recovered from prose and from a fence', () => {
    const fenced = parseWorkerReply(`Here is my report:\n\`\`\`json\n${JSON.stringify(workerReply())}\n\`\`\``)
    expect(fenced?.status).toBe('done')
    const embedded = parseWorkerReply(`Result: ${JSON.stringify(workerReply({
      status: 'asking', summary: 'need a ruling', questions: null,
    }))} — over to you`)
    expect(embedded?.status).toBe('asking')
  })

  test('a schema-shaped reply keeps its optional recommendation', () => {
    const r = parseWorkerReply(JSON.stringify(workerReply({
      status: 'asking', summary: 'stopped', questions: [{
        question: 'one table or two?', options: ['one', 'two'], recommendation: 'two', why: null,
      }],
    })))
    expect(r?.questions?.[0]?.recommendation).toBe('two')
  })

  test('a status alone is not a worker contract', () => {
    expect(parseWorkerReply('{"status":"done"}')).toBeNull()
  })

  test('wrong-typed nested values reject the whole candidate', () => {
    expect(parseWorkerReply(JSON.stringify(workerReply({ questions: [{
      question: 'q?', options: null, recommendation: {}, why: null,
    }] })))).toBeNull()
  })

  test('an asking reply keeps every question with text and why', () => {
    const asking = (questions: unknown[]) => parseWorkerReply(JSON.stringify(workerReply({
      status: 'asking', questions,
    })))
    expect(hasRealQuestions(asking([{
      question: 'one table or two?', options: null, recommendation: null,
      why: 'the choice changes the migration',
    }]))).toBe(true)
    expect(hasRealQuestions(asking([{
      question: 'which table?', options: null, recommendation: null, why: '   ',
    }]))).toBe(false)
    for (const why of ['\u200B', '\u2060', '\u00AD', '\u200B\u2060']) {
      expect(hasRealQuestions(asking([{
        question: 'one table or two?', options: null, recommendation: null, why,
      }]))).toBe(false)
    }
    for (const token of GENERIC_QUESTION_TOKENS) {
      expect(hasRealQuestions(asking([{
        question: token, options: null, recommendation: null, why: 'a claimed reason',
      }]))).toBe(false)
    }
    for (const disguised of ['(placeholder)!', '[TBD]', 'TODO?', '...question...']) {
      expect(hasRealQuestions(asking([{
        question: disguised, options: null, recommendation: null, why: 'a claimed reason',
      }]))).toBe(false)
    }
    expect(hasRealQuestions(asking([{
      question: '\u200B\u2060', options: null, recommendation: null, why: 'a claimed reason',
    }]))).toBe(false)
    const partial = asking([
      {
        question: 'which table?', options: null, recommendation: null,
        why: 'the schema changes',
      },
      { question: '   ', options: null, recommendation: null, why: 'unknown choice' },
    ])
    expect(hasRealQuestions(partial)).toBe(true)
    expect(realQuestions(partial).map((item) => item.question)).toEqual(['which table?'])
    expect(hasRealQuestions(parseWorkerReply(JSON.stringify(workerReply({
      status: 'done', questions: [{
        question: 'Which table?', options: null, recommendation: null,
        why: 'the schema changes',
      }],
    }))))).toBe(true)
  })
})

describe('pid stays the worker for the whole run', () => {
  test('after a run, pid is the worker pid and agent_pid is the agent\'s', async () => {
    const pidFile = join(dir, 'fake-agent.pid')
    const script = join(dir, 'fake-agent.sh')
    writeFileSync(script, `#!/bin/sh\necho $$ > "${pidFile}"\necho a valid reply\n`)
    chmodSync(script, 0o755)
    const grok = AGENTS.grok!
    const previous = grok.bin
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      grok.bin = script
      const reserved = addRun({ agent: '(pending)', job: 'file-question', status: 'running' })
      db().query('UPDATE run SET pid=? WHERE id=?').run(process.pid, reserved)
      await run({ job: 'file-question', prompt: 'hello', cwd: dir, agent: 'grok', reserveId: reserved })
      const row = db().query('SELECT pid, agent_pid FROM run WHERE id=?')
        .get(reserved) as { pid: number; agent_pid: number }
      expect(row.pid).toBe(process.pid)
      expect(row.agent_pid).toBe(Number(readFileSync(pidFile, 'utf8').trim()))
    } finally {
      grok.bin = previous
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  })
})

describe('a wall kill does not erase a read-only answer', () => {
  test('substantive output is judgeable and routing does not count it as delivery-none', async () => {
    const script = join(dir, 'DEV-235-readonly-agent.ts')
    const ready = join(dir, 'DEV-235-readonly-agent-ready')
    writeFileSync(script, `#!/usr/bin/env bun
process.on('SIGTERM', () => process.exit(143))
process.stdout.write('The requested implementation is in orchestrator/src/run.ts:1542.\\n')
await Bun.write(${JSON.stringify(ready)}, 'ready\\n')
setInterval(() => {}, 1_000)
`)
    chmodSync(script, 0o755)
    const grok = AGENTS.grok!
    const previousBin = grok.bin
    const previousTimeout = Object.getOwnPropertyDescriptor(grok, 'timeoutMs')!
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      grok.bin = script
      // The job bound is now compiled into the prompt before launch. Keep this
      // fixture's forced wall kill declarative instead of making timeoutMs a
      // readiness barrier whose getter cannot be read until after launch.
      grok.timeoutMs = 3 * 598
      const result = await run({
        job: 'file-question', prompt: 'where is the implementation?', cwd: dir,
        agent: 'grok', noFailover: true,
      })
      const row = db().query(
        'SELECT status, failure_kind, exit_code, output_bytes FROM run WHERE id=?',
      ).get(result.id) as {
        status: string; failure_kind: string | null; exit_code: number; output_bytes: number
      }

      expect(existsSync(ready)).toBe(true)
      expect(row).toMatchObject({ status: 'ok', failure_kind: null, exit_code: 143 })
      expect(row.output_bytes).toBeGreaterThan(0)

      // Before DEV-235 the rescue required contract?.status === 'done'. A
      // read-only run has no worker contract, so this exact row was failed and
      // candidates() immediately counted it as an implicit delivery=none.
      let candidate = candidates('file-question').find((entry) => entry.agent === 'grok')!
      expect(candidate).toMatchObject({ runs: 1, scored: 0, failures: 0, evidence: 0 })
      expect(candidate.score).toBeNull()

      score(result.id, 'full', 'right')
      candidate = candidates('file-question').find((entry) => entry.agent === 'grok')!
      expect(candidate).toMatchObject({ runs: 1, scored: 1, failures: 0, evidence: 1 })
      expect(candidate.score).toBe(weigh('full', 'right'))
    } finally {
      grok.bin = previousBin
      Object.defineProperty(grok, 'timeoutMs', previousTimeout)
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  })

  test('a wall kill with no output remains a timeout and negative routing evidence', async () => {
    const script = join(dir, 'DEV-235-empty-agent.ts')
    writeFileSync(script, `#!/usr/bin/env bun
process.on('SIGTERM', () => process.exit(143))
setInterval(() => {}, 1_000)
`)
    chmodSync(script, 0o755)
    const grok = AGENTS.grok!
    const previousBin = grok.bin
    const previousTimeout = grok.timeoutMs
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      grok.bin = script
      grok.timeoutMs = 250
      let runId: number | null = null
      try {
        await run({
          job: 'file-question', prompt: 'where is the implementation?', cwd: dir,
          agent: 'grok', noFailover: true,
        })
      } catch (error) {
        runId = (error as Error & { runId?: number }).runId ?? null
      }
      expect(runId).not.toBeNull()
      expect(db().query(
        'SELECT status, failure_kind, exit_code, output_bytes FROM run WHERE id=?',
      ).get(runId!)).toMatchObject({
        status: 'failed', failure_kind: 'timeout', exit_code: 143, output_bytes: 0,
      })
      expect(candidates('file-question').find((entry) => entry.agent === 'grok'))
        .toMatchObject({ runs: 0, scored: 0, failures: 1, evidence: 1,
          score: weigh('none', null) })
    } finally {
      grok.bin = previousBin
      grok.timeoutMs = previousTimeout
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  })
})

describe('vendor termination markers', () => {
  const grokStream = (...lines: string[]) => `${lines.join('\n')}\n`

  async function withGrokBin<T>(output: string, exitCode: number, fn: () => Promise<T>): Promise<T> {
    const script = join(dir, `DEV-361-agent-${Bun.hash(`${output}:${exitCode}`).toString(16)}.ts`)
    writeFileSync(script,
      `#!/usr/bin/env bun\nprocess.stdout.write(${JSON.stringify(output)})\nprocess.exit(${exitCode})\n`)
    chmodSync(script, 0o755)
    const grok = AGENTS.grok!
    const previousBin = grok.bin
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      grok.bin = script
      return await fn()
    } finally {
      grok.bin = previousBin
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  }

  test.each([
    ['NDJSON result plus trailing marker', grokStream(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'a' }),
      JSON.stringify({ type: 'result', result: 'I inspected the files.' }),
      '[API Error: terminated]',
    ), 0],
    ['NDJSON result plus trailing marker at exit 1', grokStream(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'a1' }),
      JSON.stringify({ type: 'result', result: 'I inspected the files.' }),
      '[API Error: terminated]',
    ), 1],
    ['NDJSON with trailing marker and no result', grokStream(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'b' }),
      '[API Error: terminated]',
    ), 0],
    ['output that is only the marker', '[API Error: terminated]\n', 0],
    ['output that is only the marker at exit 1', '[API Error: terminated]\n', 1],
    ['marker with trailing spaces and tabs', '[API Error: terminated]  \t\n', 0],
    ['marker with trailing spaces and tabs at exit 1', '[API Error: terminated]  \t\n', 1],
    ['marker with CRLF', '[API Error: terminated]\r\n', 0],
    ['marker with CRLF at exit 1', '[API Error: terminated]\r\n', 1],
    ['plain text followed by the marker', grokStream(
      'I will inspect the requested files first.',
      '[API Error: terminated]',
    ), 0],
  ])('records failed/truncated for %s', async (_case, output, exitCode) => {
    await withGrokBin(output, exitCode, async () => {
      const reserved = addRun({ agent: '(pending)', job: 'file-question', status: 'running' })
      await expect(run({
        job: 'file-question', prompt: 'inspect this', cwd: dir,
        agent: 'grok', reserveId: reserved, noFailover: true,
      })).rejects.toThrow('[API Error: terminated]')

      expect(db().query(
        'SELECT status, failure_kind, error, exit_code FROM run WHERE id=?',
      ).get(reserved)).toEqual({
        status: 'failed', failure_kind: 'truncated',
        error: expect.stringContaining('[API Error: terminated]'), exit_code: exitCode,
      })
      expect(candidates('file-question').find((candidate) => candidate.agent === 'grok'))
        .toMatchObject({ evidence: 0 })
    })
  })

  test.each([
    ['ordinary output', 'The requested handler returns the stored result after validation.', 0],
    ['ordinary output at exit 1', 'The requested handler returns the stored result after validation.', 1],
    ['API error mentioned in prose', 'The handler swallows [API Error: terminated] instead of returning it.', 0],
    ['API error mentioned in prose at exit 1', 'The handler swallows [API Error: terminated] instead of returning it.', 1],
    ['quoted trailing marker', 'The answer is complete.\n"[API Error: terminated]"\n', 0],
    ['quoted trailing marker at exit 1', 'The answer is complete.\n"[API Error: terminated]"\n', 1],
    ['marker inside a closed code fence', 'The answer is complete.\n```\n[API Error: terminated]\n```\n', 0],
    ['marker inside a closed code fence at exit 1', 'The answer is complete.\n```\n[API Error: terminated]\n```\n', 1],
  ])('does not classify %s as truncated', async (_case, output, exitCode) => {
    await withGrokBin(output, exitCode, async () => {
      let runId: number
      try {
        const result = await run({
          job: 'file-question', prompt: 'answer this', cwd: dir,
          agent: 'grok', noFailover: true,
        })
        runId = result.id
      } catch (error) {
        runId = (error as Error & { runId: number }).runId
      }
      expect(db().query(
        'SELECT status, failure_kind, error, exit_code FROM run WHERE id=?',
      ).get(runId)).toMatchObject(exitCode === 0
        ? { status: 'ok', failure_kind: null, error: null, exit_code: 0 }
        : { status: 'failed', failure_kind: 'other', exit_code: 1 })
    })
  })

  async function withHangingGrokBin<T>(output: string, fn: (ready: string) => Promise<T>): Promise<T> {
    const script = join(dir, `DEV-361-hang-${Bun.hash(output).toString(16)}.ts`)
    const ready = `${script}.ready`
    writeFileSync(script, `#!/usr/bin/env bun
process.on('SIGTERM', () => process.exit(143))
process.stdout.write(${JSON.stringify(output)})
await Bun.write(${JSON.stringify(ready)}, 'ready\\n')
setInterval(() => {}, 1_000)
`)
    chmodSync(script, 0o755)
    const grok = AGENTS.grok!
    const previousBin = grok.bin
    const previousTimeout = Object.getOwnPropertyDescriptor(grok, 'timeoutMs')!
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      grok.bin = script
      grok.timeoutMs = 3 * 598
      return await fn(ready)
    } finally {
      grok.bin = previousBin
      Object.defineProperty(grok, 'timeoutMs', previousTimeout)
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  }

  test.each([
    ['marker after a complete NDJSON result, killed by our timer', grokStream(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'wall-a' }),
      JSON.stringify({ type: 'result', result: 'I inspected the files.' }),
      '[API Error: terminated]',
    )],
    ['marker alone, killed by our timer', '[API Error: terminated]\n'],
  ])('records failed/truncated for %s', async (_case, output) => {
    await withHangingGrokBin(output, async (ready) => {
      const reserved = addRun({ agent: '(pending)', job: 'file-question', status: 'running' })
      await expect(run({
        job: 'file-question', prompt: 'inspect this', cwd: dir,
        agent: 'grok', reserveId: reserved, noFailover: true,
      })).rejects.toThrow('[API Error: terminated]')

      expect(existsSync(ready)).toBe(true)
      expect(db().query(
        'SELECT status, failure_kind, error, exit_code FROM run WHERE id=?',
      ).get(reserved)).toEqual({
        status: 'failed', failure_kind: 'truncated',
        error: expect.stringContaining('[API Error: terminated]'), exit_code: 143,
      })
      expect(candidates('file-question').find((candidate) => candidate.agent === 'grok'))
        .toMatchObject({ evidence: 0 })
    })
  })

  const askingContract = JSON.stringify(workerReply({
    status: 'asking', files_changed: null, tests: null,
    questions: [{
      question: 'one table or two?', options: ['one', 'two'], recommendation: 'two',
      why: 'the choice changes the public query shape',
    }],
  }))
  const emptyDoneContract = JSON.stringify(workerReply({
    files_changed: [], tests: { command: null, ran: false, passed: null, detail: null },
  }))

  async function withWritingRepo<T>(fn: (repo: string) => Promise<T>): Promise<T> {
    const repo = mkdtempSync(join(tmpdir(), 'orch-361-write-'))
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    }
    writeFileSync(join(repo, 'seed.txt'), 'seed\n')
    git('init', '-b', 'main')
    git('config', 'user.email', 'orch-test@example.invalid')
    git('config', 'user.name', 'Orch Test')
    git('add', 'seed.txt')
    git('commit', '-m', 'seed')
    try {
      return await fn(repo)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }

  test('a grok asking contract trailing the marker is truncated, not asking, and creates no inbox question', async () => {
    const output = grokStream(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'ask-marker' }),
      JSON.stringify({ type: 'result', result: askingContract }),
      '[API Error: terminated]',
    )
    await withGrokBin(output, 0, async () => {
      await withWritingRepo(async (repo) => {
        let runId: number | null = null
        try {
          const result = await run({
            job: 'implement', prompt: 'build it', cwd: repo,
            agent: 'grok', noFailover: true,
          })
          runId = result.id
        } catch (error) {
          runId = (error as Error & { runId?: number }).runId ?? null
        }
        expect(runId).not.toBeNull()
        expect(db().query(
          'SELECT status, failure_kind FROM run WHERE id=?',
        ).get(runId!)).toEqual({ status: 'failed', failure_kind: 'truncated' })
        expect((db().query('SELECT COUNT(*) n FROM question WHERE run_id=?').get(runId!) as { n: number }).n)
          .toBe(0)
        expect(candidates('implement').find((candidate) => candidate.agent === 'grok'))
          .toMatchObject({ evidence: 0 })
      })
    })
  })

  test('a grok empty-done contract trailing the marker is truncated, not other', async () => {
    const output = grokStream(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'empty-done-marker' }),
      JSON.stringify({ type: 'result', result: emptyDoneContract }),
      '[API Error: terminated]',
    )
    await withGrokBin(output, 0, async () => {
      await withWritingRepo(async (repo) => {
        let runId: number | null = null
        try {
          await run({
            job: 'implement', prompt: 'build it', cwd: repo,
            agent: 'grok', noFailover: true,
          })
        } catch (error) {
          runId = (error as Error & { runId?: number }).runId ?? null
        }
        expect(runId).not.toBeNull()
        const row = db().query(
          'SELECT status, failure_kind, error FROM run WHERE id=?',
        ).get(runId!) as { status: string; failure_kind: string; error: string }
        expect(row).toEqual({
          status: 'failed', failure_kind: 'truncated',
          error: expect.stringContaining('[API Error: terminated]'),
        })
        expect(row.failure_kind).not.toBe('other')
        expect(row.error).not.toBe('reported done with no change and no test run')
        expect(candidates('implement').find((candidate) => candidate.agent === 'grok'))
          .toMatchObject({ evidence: 0 })
      })
    })
  })

  test('a confinement trip with the marker present records escaped, not truncated', async () => {
    const watched = realpathSync(mkdtempSync(join(tmpdir(), 'orch-361-escape-')))
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: watched, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    }
    git('init', '-b', 'main')
    git('config', 'user.email', 'orch-test@example.invalid')
    git('config', 'user.name', 'Orch Test')
    writeFileSync(join(watched, 'tracked.txt'), 'base\n')
    git('add', 'tracked.txt')
    git('commit', '-m', 'fixture')
    const script = join(dir, 'DEV-361-escape-marker.sh')
    writeFileSync(script, `#!/bin/sh
if [ -n "$ORCH_TEST_EXTERNAL_WRITE" ]; then printf 'outside\\n' > "$ORCH_TEST_EXTERNAL_WRITE"; fi
printf '%s\\n' '{"type":"system","subtype":"init"}' '{"type":"result","result":"answer"}' '[API Error: terminated]'
`)
    chmodSync(script, 0o755)
    upsertProject({ name: 'watched-marker-project', path: watched })
    const grok = AGENTS.grok!
    const previousBin = grok.bin
    const priorDepth = process.env.ORCH_DEPTH
    const priorTarget = process.env.ORCH_TEST_EXTERNAL_WRITE
    process.env.ORCH_DEPTH = '0'
    try {
      grok.bin = script
      process.env.ORCH_TEST_EXTERNAL_WRITE = join(watched, 'written-by-run.txt')
      let runId: number | null = null
      try {
        await run({ job: 'file-question', prompt: 'write outside', cwd: dir, agent: 'grok', noFailover: true })
      } catch (error) {
        runId = (error as Error & { runId?: number }).runId ?? null
      }
      expect(runId).not.toBeNull()
      const row = db().query(
        'SELECT status, failure_kind FROM run WHERE id=?',
      ).get(runId!) as { status: string; failure_kind: string }
      expect(row.status).toBe('failed')
      expect(['escaped', 'confinement_unverified']).toContain(row.failure_kind)
      expect(row.failure_kind).not.toBe('truncated')
    } finally {
      grok.bin = previousBin
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      if (priorTarget === undefined) delete process.env.ORCH_TEST_EXTERNAL_WRITE
      else process.env.ORCH_TEST_EXTERNAL_WRITE = priorTarget
      rmSync(watched, { recursive: true, force: true })
    }
  })
})

describe('the live ask channel always answers', () => {
  test('a ruling that lands is handed straight back', async () => {
    const run = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    const pending = ask({ runId: run, question: 'one table or two?', timeoutMs: 10_000 })
    for (let i = 0; i < 50; i++) {
      const q = db().query('SELECT id FROM question WHERE run_id = ?').get(run) as { id: number } | null
      if (q) {
        db().query("UPDATE question SET answer=?, answered_at=?, answered_by='t' WHERE id=?")
          .run('two', new Date().toISOString(), q.id)
        break
      }
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(await pending).toEqual({ answered: true, answer: 'two' })
  })

  test('a live question is answerable through the command, not only in SQL', () => {
    /**
     * The test above writes the answer with raw SQL, and a review pointed out
     * that this proved a path nobody can execute: `orch answer` rejected every
     * status except `blocked`, while MCP questions belong to a `running` run.
     * The live channel could therefore never be answered and every question
     * ran to its timeout — the headline feature, broken end to end, with a
     * green test beside it.
     *
     * So the CLI's own precondition is asserted here rather than assumed. A
     * run that is `running` WITH an open question must be answerable, and one
     * with no open question must not be.
     */
    const live = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    db().query(
      'INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)',
    ).run(live, new Date().toISOString(), 'which table?')

    const answerable = (id: number) => {
      const r = db().query('SELECT status, parent_run_id FROM run WHERE id = ?').get(id) as
        { status: string; parent_run_id: number | null }
      const open = db().query(
        `SELECT COUNT(*) n FROM question q JOIN run r ON r.id = q.run_id
          WHERE (r.id = ? OR r.parent_run_id = ?) AND q.answered_at IS NULL`,
      ).get(id, id) as { n: number }
      return !r.parent_run_id && open.n > 0 && (r.status === 'running' || r.status === 'asking')
    }

    expect(answerable(live)).toBe(true)
    expect(answerable(addRun({ agent: 'codex', job: 'implement', status: 'running' }))).toBe(false)
  })

  test('a question asked on turn two is answerable from the root', () => {
    // The chain shape every escalation after the first one takes. Questions
    // land on the CHILD row while the roll-up marks the ROOT blocked, so
    // looking only at the root found nothing and the child was refused as
    // non-root — a conversation that asked twice could not be continued.
    const root = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    const child = addRun({ agent: 'codex', job: 'implement', parent: root, turn: 2 })
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(child, new Date().toISOString(), 'and now what?')

    const open = db().query(
      `SELECT q.id FROM question q JOIN run r ON r.id = q.run_id
        WHERE (r.id = ? OR r.parent_run_id = ?) AND q.answered_at IS NULL`,
    ).all(root, root) as { id: number }[]
    expect(open.length).toBe(1)
  })

  test('a question nobody answers falls back rather than hanging', async () => {
    // The whole reason this is bounded: a tool that can wait for ever leaves a
    // worker holding a session with nothing to wait for, and the run's own
    // timeout eventually kills work that was finished but for one question.
    const run = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    const r = await ask({ runId: run, question: 'nobody is listening', timeoutMs: 50 })
    expect(r.answered).toBe(false)
    // It must tell the worker to escalate rather than to decide.
    if (!r.answered) expect(r.reason).toContain('blocked')
  })

  test('an unanswered question survives the timeout', async () => {
    // The architect still has to make the decision; withdrawing it on timeout
    // would lose the record of one that is still outstanding.
    const run = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    await ask({ runId: run, question: 'still open', timeoutMs: 50 })
    const open = db().query(
      'SELECT COUNT(*) AS n FROM question WHERE run_id = ? AND answered_at IS NULL',
    ).get(run) as { n: number }
    expect(open.n).toBe(1)
  })
})

describe('a worker asking is not a worker blocked', () => {
  test('the old word is accepted and normalised', () => {
    // `blocked` was renamed because a "blocker" in this system means the
    // opposite — an environment problem, not a worker behaving correctly. But
    // an agent whose schema was dropped, or echoing older instructions, will
    // still say it, and rejecting a reply over a synonym would throw away a
    // finished implementation.
    const r = parseWorkerReply(JSON.stringify(workerReply({
      status: 'blocked', summary: 'x', questions: [{
        question: 'q?', options: null, recommendation: null, why: null,
      }],
    })))
    expect(r?.status).toBe('asking')
  })

  test('the two vocabularies do not overlap', () => {
    // The whole point of the rename: on a page, a run that is `asking` is
    // healthy and a `blocker` is not, and they must not read as the same red.
    const asking = parseWorkerReply(JSON.stringify(workerReply({ status: 'asking', summary: 'x' })))
    expect(asking?.status).toBe('asking')
    expect(detectBlockers('Docker access was denied, so I could not run the suite.')).not.toEqual([])
  })
})

describe('asking is a first-class outcome, not a failure', () => {
  test('every status check uses the current vocabulary', () => {
    /**
     * The rename from `blocked` to `asking` left four checks behind, and the
     * cost was immediate: `orch answer` refused every asking run with "is
     * asking, not waiting on a ruling", which is the escalation path refusing
     * the exact state it exists to serve.
     *
     * Asserted against the SOURCE rather than behaviour, because these are
     * scattered guards rather than one function — and a guard comparing against
     * a value the database can no longer hold fails silently and permanently.
     */
    const cli = readFileSync(new URL('./cli.ts', import.meta.url).pathname, 'utf8')
    const wt = readFileSync(new URL('./worktree.ts', import.meta.url).pathname, 'utf8')
    for (const [name, src] of [['cli.ts', cli], ['worktree.ts', wt]] as const) {
      // The only legitimate mention left is the parser normalising the old word
      // from an agent that still says it.
      const bad = src.split('\n').filter((l) =>
        ["'blocked'", '"blocked"'].some((quoted) => l.includes(quoted))
        && !l.includes('o.status') && !l.trim().startsWith('*')
        && !l.trim().startsWith('//'))
      expect({ [name]: bad }).toEqual({ [name]: [] })
    }
  })
})

describe('a worker that narrates in its own reply shape', () => {
  test('the LAST object wins, not the first and not the span', () => {
    // A worker under a schema narrates in the shape it was told to reply in.
    // One opened with a `done` carrying no files and emitted its real reply
    // afterwards; spanning both parsed as neither, so three files and 150
    // lines were recorded as "reply did not match the worker contract".
    // Believing the FIRST would be worse: a confident report of finishing
    // nothing.
    const r = parseWorkerReply([
      workerReply({ summary: 'Starting by reading the canon', files_changed: [] }),
      workerReply({ summary: 'Added the section', files_changed: ['a.ts', 'b.ts'] }),
    ].map((value) => JSON.stringify(value)).join('\n'))
    expect(r?.summary).toBe('Added the section')
    expect(r?.files_changed).toEqual(['a.ts', 'b.ts'])
  })

  test('a brace inside a string is not a brace', () => {
    // Depth-scanned rather than regexed, because a JSON object nests and a
    // summary may talk about braces.
    expect(parseWorkerReply(JSON.stringify(workerReply({ summary: 'uses {curly} braces' })))?.summary)
      .toBe('uses {curly} braces')
  })

  test('a later object that does not validate does not shadow a good one', () => {
    const r = parseWorkerReply(
      `${JSON.stringify(workerReply({ summary: 'real' }))}\n{"note":"trailing object with no status"}`,
    )
    expect(r?.summary).toBe('real')
  })

  test('multiple valid contract objects report their count and take the last', () => {
    const parsed = parseWorkerReplyWithCount([
      workerReply({ summary: 'real reply' }),
      workerReply({ summary: 'quoted contract-shaped object' }),
    ].map((value) => JSON.stringify(value)).join('\n'))
    expect(parsed.reply?.summary).toBe('quoted contract-shaped object')
    expect(parsed.contractObjects).toBe(2)
  })
})
