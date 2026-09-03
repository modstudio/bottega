/**
 * Tests for the parts that decide things.
 *
 * There were none, and the cost of that showed up all at once: routing counted
 * only successful runs, the guide carried a second copy of the same maths that
 * had drifted from it, the stale sweep tested a pid that was never present
 * while a run was alive, and `tsc` had never completed even once. Every one of
 * those is a pure function of the database, and every one is checked below.
 *
 * The database is the seam. The suite builds one in a temp file via ORCH_DB
 * rather than touching orch.db, so a test run can never teach the real router
 * anything.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { appendFileSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync,
         realpathSync, mkdirSync, utimesSync, chmodSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

/**
 * One database for the whole file, chosen before anything imports db.ts.
 *
 * db() caches its handle and DB_PATH is read at module load, so a per-test
 * database would need the whole module graph reloaded — and route.ts imports
 * db.ts by a plain specifier, which Bun caches once however the test file
 * spells its own import. Reloading only the modules the test names left route.ts
 * talking to the first test's file, which had already been deleted. Clearing the
 * tables between tests is both simpler and closer to how this actually runs.
 */
const dir = mkdtempSync(join(tmpdir(), 'orch-test-'))
process.env.ORCH_DB = join(dir, 'test.db')

const { db, reapStale, pendingForSession, unscoredCount, judgeability, STALE_AFTER_MS,
        PENDING_BOOTSTRAP_MS, WEIGHT, weigh, label, FIDELITY_PENALTY, UNSCORED_WHERE,
        excludeSharedOutputRuns, SHARED_OUTPUT_REASON, applySchema, recordDuels, duelMatrices,
        parseRunIds } = await import('./db.ts')
const { candidates, weightCase, scoreboard, median, evidenceFor, pick,
        NOISE_BAND, QUALITY_STEP, MIN_SAMPLE, OUTPUT_RESERVE, EVIDENCE_WINDOW,
        STANDING_EXPLORE_RATE } = await import('./route.ts')
const { guide } = await import('./guide.ts')
const { projects, projectAt, stackAt, upsertProject } = await import('./projects.ts')
const { dbNameFor, recipeNotes, runRecipe, fill } = await import('./recipe.ts')
const { JOBS } = await import('./jobs.ts')
const { runDetail, state } = await import('./serve.ts')
const { classify, NEEDS_HUMAN, NEEDS_HUMAN_TITLE, NOT_EVIDENCE, COOLS_DOWN,
        isNonAnswer, detectBlockers } = await import('./failure.ts')
const { errorTail, preflight, detachedRunOptions, runFilePaths, pruneRuns, KEEP_RUN_FILES_DAYS,
        run: runJob } = await import('./run.ts')
const run = runJob
const { summary } = await import('./metric.ts')
const { parseWorkerReply, parseWorkerReplyWithCount, READONLY_PREAMBLE } = await import('./contract.ts')
const { ask } = await import('./ask.ts')
const { orphanSafety, repoRootOf, createWorktree, createWithTool, resolveBase, fillTool } = await import('./worktree.ts')
const { AGENTS, localReachable, ensureLocalHealth, resetLocalHealth,
        unavailableReason, available, NEEDS_HEALTH, wakeDecision,
        WAKE_COOLDOWN_MS, CODEX_EXEC_SANDBOX, strictCodexSchema } = await import('./agents.ts')
const { listDocs, getDoc, setDoc, removeDoc, docsForRun, exportDocs, importDocs, brief, docSubjects } =
  await import('./docs.ts')
const { createDocsMcpServer } = await import('./mcp.ts')

beforeEach(() => {
  // question cascades from run, but the delete order still matters: it is
  // listed first so a future FK-enforcing change cannot make this fail
  // mysteriously halfway through a suite.
  db().exec('DELETE FROM doc; DELETE FROM question; DELETE FROM duel; DELETE FROM calibration; DELETE FROM score; DELETE FROM run; DELETE FROM project;')
})

afterAll(() => {
  delete process.env.ORCH_DB
  rmSync(dir, { recursive: true, force: true })
})

/** Insert a finished run. Returns its id. */
function addRun(o: {
  agent: string; job: string; status?: string; latency?: number; probe?: number
  kind?: string; parent?: number; turn?: number; session?: string | null; stack?: string
  model?: string; startedAt?: string
}): number {
  return (db().query(
    `INSERT INTO run (started_at, agent, job, prompt_sha, prompt_bytes, prompt_head,
                      status, latency_ms, probe, failure_kind, parent_run_id, turn, session_id, stack,
                      model)
     VALUES (?,?,?,'sha',10,'head',?,?,?,?,?,?,?,?,?) RETURNING id`,
  ).get(
    o.startedAt ?? new Date().toISOString(), o.agent, o.job,
    o.status ?? 'ok', o.latency ?? 1000, o.probe ?? 0, o.kind ?? null,
    o.parent ?? null, o.turn ?? 1, o.session ?? null, o.stack ?? null,
    o.model ?? AGENTS[o.agent]?.model ?? null,
  ) as { id: number }).id
}

function score(
  runId: number, delivery: string, quality: string | null = null, fidelity: string | null = null,
) {
  db().query(
    'INSERT INTO score (run_id, delivery, quality, fidelity, scored_at) VALUES (?,?,?,?,?)',
  ).run(runId, delivery, quality, fidelity, new Date().toISOString())
}

function workerReply(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'done', summary: 'done', files_changed: ['changed.ts'], questions: null,
    deviations: null, tests: { command: 'bun test', ran: true, passed: true, detail: null },
    blockers: null, ...overrides,
  }
}

describe('failure classification', () => {
  test("OpenAI's invalid response schema is a harness failure", () => {
    expect(classify(
      "Invalid schema for response_format 'codex_output_schema': additionalProperties is required",
    )).toBe('harness')
  })

  test("Codex's own banner is not a permission denial", () => {
    // The banner Codex prints before it says anything, followed by the real
    // error. `approval` used to match here and stamped `denied` on it.
    const codexBanner = [
      'OpenAI Codex v0.151.0', '--------',
      'workdir: /workspace/y', 'model: gpt-5.6-sol',
      'approval: never', 'sandbox: read-only', '',
      'ERROR: Unexpected message role', 'stream disconnected',
    ].join('\n')
    expect(classify(codexBanner)).not.toBe('denied')
  })

  test('a real headless denial still classifies as denied', () => {
    expect(classify('jetski: no output produced — a tool required the "read_file" permission')).toBe('denied')
    expect(classify('the command was auto-denied by headless mode')).toBe('denied')
  })

  test('quota and auth are separated, because only one is fixed by waiting', () => {
    expect(classify('HTTP 429: rate limit exceeded')).toBe('quota')
    expect(classify('401 unauthorized')).toBe('auth')
    expect(NEEDS_HUMAN).toEqual(['quota', 'auth', 'unreachable'])
  })

  test('an endpoint that is not there is unreachable, not a verdict', () => {
    // The exact string Qwen Code produced while the local model host was
    // powered off, and the shapes a tunnel or a refused socket produce.
    expect(classify('[API Error: Connection error.]')).toBe('unreachable')
    expect(classify('connect ECONNREFUSED 127.0.0.1:8010')).toBe('unreachable')
    expect(classify('ssh: connect to host 192.0.2.10 port 22: No route to host'))
      .toBe('unreachable')
    expect(classify('Unable to connect. Is the computer able to access the url?'))
      .toBe('unreachable')
  })

  test('what the room did is not evidence about the agent', () => {
    // Every other kind is something the agent did. These three are not: a box
    // switched off, an operator killing the process tree, and orch itself being
    // wrong — a schema a validator rejected before the agent did any work, or a
    // precondition orch should have checked before spending a run. None of them
    // may be averaged in with the rest.
    expect(NOT_EVIDENCE).toEqual(['unreachable', 'interrupted', 'harness', 'abandoned'])
    for (const kind of ['quota', 'auth', 'timeout', 'denied', 'other']) {
      expect(NOT_EVIDENCE).not.toContain(kind)
    }
  })

  test('a killed process tree is interrupted, not a verdict on the agent', () => {
    // The exact string run.ts writes when the child died with no output and our
    // own timer never fired: a foreground `orch do` outliving the calling
    // harness's command timeout. 143 is SIGTERM, 130 SIGINT, 137 SIGKILL.
    expect(classify('exit 143, empty output')).toBe('interrupted')
    expect(classify('exit 130, empty output')).toBe('interrupted')
    expect(classify('exit 137, empty output')).toBe('interrupted')
    // A different exit code is not this. It means the agent ran and failed on
    // its own, which IS its record.
    expect(classify('exit 1, empty output')).toBe('other')
    // Anchored whole-string, so a reply that merely discusses the shape - a
    // review of this very file would - is never thrown away as a failure.
    expect(classify('the wrapper reported exit 143, empty output, which we now classify'))
      .toBe('other')
  })

  test('an interrupted run neither cools the agent down nor pages a person', () => {
    // Nothing to wait out and nothing to fix: the kill came from the caller,
    // and the same command run detached would not have produced it.
    expect(COOLS_DOWN).not.toContain('interrupted')
    expect(NEEDS_HUMAN).not.toContain('interrupted')
  })

  test('unreachable tells a person but does not cool the agent down', () => {
    // A cooldown is for what only a run can detect. Quota and auth announce
    // themselves by failing; reachability is measured before every route for
    // the price of one local HTTP call, so waiting an hour buys nothing and
    // costs the whole recovery window.
    expect(NEEDS_HUMAN).toContain('unreachable')
    expect(COOLS_DOWN).not.toContain('unreachable')
    expect(COOLS_DOWN).toEqual(['quota', 'auth'])
  })

  test('a peer that reset stays a timeout — it answered before it stopped', () => {
    // Guards the deliberate narrowness of the unreachable pattern. Reclassifying
    // this on no evidence would trade one guess for another.
    expect(classify('kex_exchange_identification: read: Connection reset by peer'))
      .toBe('timeout')
  })

  test('every kind needing a human has something to tell them', () => {
    // A ternary covered two and would have called the third an auth problem.
    for (const kind of NEEDS_HUMAN) {
      expect(typeof NEEDS_HUMAN_TITLE[kind]).toBe('function')
      expect(NEEDS_HUMAN_TITLE[kind]!('qwen-local')).toContain('qwen-local')
    }
  })

  test('an unrecognised failure is reported as other, never swallowed', () => {
    expect(classify('something nobody has seen before')).toBe('other')
    expect(classify(null)).toBe('other')
  })
})

describe('Codex strict output schemas', () => {
  test('normalizes nested objects and makes optional fields nullable', () => {
    expect(strictCodexSchema({
      type: 'object',
      properties: {
        title: { type: 'string' },
        detail: {
          type: 'object',
          properties: {
            count: { type: 'number' },
            note: { anyOf: [{ type: 'string' }, { type: 'number' }] },
          },
          required: ['count'],
        },
      },
      required: ['title'],
    })).toEqual({
      type: 'object',
      properties: {
        title: { type: 'string' },
        detail: {
          type: ['object', 'null'],
          properties: {
            count: { type: 'number' },
            note: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }] },
          },
          required: ['count', 'note'],
          additionalProperties: false,
        },
      },
      required: ['title', 'detail'],
      additionalProperties: false,
    })
  })
})

describe('routing counts failures as evidence', () => {
  test('an agent that mostly fails does not look flawless', () => {
    // agy's real review-lens record: one good answer, two headless denials.
    score(addRun({ agent: 'agy', job: 'review-lens' }), 'full', 'right')
    addRun({ agent: 'agy', job: 'review-lens', status: 'failed' })
    addRun({ agent: 'agy', job: 'review-lens', status: 'failed' })

    const agy = candidates('review-lens').find((c) => c.agent === 'agy')!
    expect(agy.scored).toBe(1)
    expect(agy.failures).toBe(2)
    expect(agy.evidence).toBe(3)
    // (one full/right + two delivery failures) / 3
    expect(agy.score).toBeCloseTo((weigh('full', 'right') + 2 * weigh('none', null)) / 3)
    // The whole point: this is no longer a perfect record.
    expect(agy.score).toBeLessThan(weigh('full', 'right'))
  })

  test('a failed run that someone also scored counts once, not twice', () => {
    // A run contributes exactly one judgement. Counting the failure AND the
    // score doubled the evidence for the same run, so an agent could be
    // declared proven on half the runs it should have needed.
    const id = addRun({ agent: 'codex', job: 'craft', status: 'failed' })
    score(id, 'none')
    const c = candidates('craft').find((x) => x.agent === 'codex')!
    expect(c.scored).toBe(1)
    expect(c.failures).toBe(0)   // already represented by the score
    expect(c.evidence).toBe(1)   // one run, one judgement
    expect(c.score).toBe(weigh('none', null))
  })

  test('an explicit score on an interrupted run is not routing evidence', () => {
    score(addRun({ agent: 'codex', job: 'craft' }), 'full', 'right')
    const interrupted = addRun({
      agent: 'codex', job: 'craft', status: 'failed', kind: 'interrupted',
    })
    score(interrupted, 'none')

    const c = candidates('craft').find((x) => x.agent === 'codex')!
    expect(c.scored).toBe(1)
    expect(c.evidence).toBe(1)
    expect(c.score).toBe(weigh('full', 'right'))
  })

  test('an unjudged failure still counts, or failing would be free', () => {
    addRun({ agent: 'grok', job: 'craft', status: 'failed' })
    const c = candidates('craft').find((x) => x.agent === 'grok')!
    expect(c.scored).toBe(0)
    expect(c.failures).toBe(1)
    expect(c.evidence).toBe(1)
    expect(c.score).toBe(weigh('none', null))
  })

  test('evidence never exceeds the number of runs behind it', () => {
    // The invariant the double count broke.
    score(addRun({ agent: 'codex', job: 'safety' }), 'full', 'right')
    score(addRun({ agent: 'codex', job: 'safety', status: 'failed' }), 'none')
    addRun({ agent: 'codex', job: 'safety', status: 'stale' })
    addRun({ agent: 'codex', job: 'safety' })  // ok, unscored
    const c = candidates('safety').find((x) => x.agent === 'codex')!
    expect(c.evidence).toBeLessThanOrEqual(4)
    expect(c.evidence).toBe(3)  // the unscored OK run is not yet a judgement
  })

  test('a woken box is usable at once, not in an hour', () => {
    // The bug this pins: wake succeeds, the box is serving five minutes later,
    // and routing still refuses it for the remaining fifty-five because the
    // last run had failed `unreachable`.
    db().query(
      `INSERT INTO run (started_at, agent, job, prompt_sha, prompt_bytes, prompt_head,
                        status, failure_kind)
       VALUES (datetime('now','-5 minutes'),'qwen-local','file-question','s',10,'h',
               'failed','unreachable')`,
    ).run()
    const c = candidates('file-question').find((x) => x.agent === 'qwen-local')!
    expect(c.cooling).toBeNull()
  })

  test('quota still cools, because only a run can tell you it has cleared', () => {
    db().query(
      `INSERT INTO run (started_at, agent, job, prompt_sha, prompt_bytes, prompt_head,
                        status, failure_kind)
       VALUES (datetime('now','-5 minutes'),'codex','craft','s',10,'h','failed','quota')`,
    ).run()
    const c = candidates('craft').find((x) => x.agent === 'codex')!
    expect(c.cooling).toContain('quota')
  })

  test('an outage is not a verdict — the room failed, not the agent', () => {
    // The local model host was powered off for eleven hours. Routing kept sending
    // qwen-local its best job and kept recording the failures against it.
    score(addRun({ agent: 'qwen-local', job: 'file-question' }), 'full', 'right')
    score(addRun({ agent: 'qwen-local', job: 'file-question' }), 'full', 'right')
    addRun({ agent: 'qwen-local', job: 'file-question', status: 'failed',
             kind: 'unreachable' })
    addRun({ agent: 'qwen-local', job: 'file-question', status: 'failed',
             kind: 'unreachable' })

    const c = candidates('file-question').find((x) => x.agent === 'qwen-local')!
    expect(c.failures).toBe(0)          // neither outage is charged to the model
    expect(c.evidence).toBe(2)          // only the two real verdicts
    expect(c.score).toBe(weigh('full', 'right'))
  })

  test('every OTHER failure kind is still evidence, outage or not', () => {
    // The exclusion is surgical. A quota failure needs a person too, and is
    // still an honest fact about what this agent could do today.
    for (const kind of ['quota', 'auth', 'timeout', 'denied', 'other']) {
      db().exec('DELETE FROM score; DELETE FROM run;')
      addRun({ agent: 'codex', job: 'craft', status: 'failed', kind })
      const c = candidates('craft').find((x) => x.agent === 'codex')!
      expect(c.failures).toBe(1)
      expect(c.evidence).toBe(1)
    }
  })

  test('an unclassified failure is still evidence, so the exclusion cannot leak', () => {
    // COALESCE, not a bare NOT IN: a NULL failure_kind must stay countable.
    // Without it every pre-classification row would silently stop counting.
    addRun({ agent: 'grok', job: 'craft', status: 'failed' })   // kind NULL
    const c = candidates('craft').find((x) => x.agent === 'grok')!
    expect(c.failures).toBe(1)
  })

  test('an abandoned run counts against the agent when nothing says why', () => {
    // A bare stale row - no kind - is still charged. Only the reaper's own
    // verdict clears it, and the reaper is the thing that knows the process was
    // killed rather than merely slow.
    addRun({ agent: 'grok', job: 'craft', status: 'stale' })
    const grok = candidates('craft').find((c) => c.agent === 'grok')!
    expect(grok.failures).toBe(1)
    expect(grok.evidence).toBe(1)
  })

  test('a run the reaper swept is not evidence about the agent', () => {
    // What the reaper sweeps is a process that died without writing its own
    // terminal state. It cannot be a hang: every agent's timeout is below
    // STALE_AFTER_MS, so a slow run is stopped by its own timer and recorded as
    // `timeout`, which IS charged. This is a kill from outside - the caller's
    // command timeout taking the process group down - and charging it to the
    // model makes the harness's impatience look like the agent's incompetence.
    addRun({ agent: 'grok', job: 'craft', status: 'stale', kind: 'interrupted' })
    const grok = candidates('craft').find((c) => c.agent === 'grok')!
    expect(grok.failures).toBe(0)
    expect(grok.evidence).toBe(0)
  })

  test('probes are evidence about nothing, success or failure', () => {
    score(addRun({ agent: 'grok', job: 'craft', probe: 1 }), 'full', 'right')
    addRun({ agent: 'grok', job: 'craft', status: 'failed', probe: 1 })
    const grok = candidates('craft').find((c) => c.agent === 'grok')!
    expect(grok.evidence).toBe(0)
    expect(grok.score).toBeNull()
  })

  test('an untried agent has no score, which is not the same as a bad one', () => {
    const c = candidates('review-lens').find((x) => x.agent === 'codex')!
    expect(c.score).toBeNull()
    expect(c.evidence).toBe(0)
  })
})

describe('reapStale', () => {
  test('a run older than the cutoff is swept even when its pid is alive', () => {
    const id = addRun({ agent: 'grok', job: 'craft', status: 'running' })
    // process.pid is certainly alive: this is the recycled-pid case, and the
    // age cutoff has to win it.
    db().query('UPDATE run SET started_at=?, pid=? WHERE id=?')
      .run(new Date(Date.now() - STALE_AFTER_MS - 60_000).toISOString(), process.pid, id)

    expect(reapStale(db())).toBe(1)
    expect((db().query('SELECT status FROM run WHERE id=?').get(id) as { status: string }).status)
      .toBe('stale')
  })

  test('a recent run whose process is gone is swept at once, not in thirty minutes', () => {
    const id = addRun({ agent: 'grok', job: 'craft', status: 'running' })
    // Nothing owns pid 2^22; it is above every configured pid_max.
    db().query('UPDATE run SET pid=? WHERE id=?').run(4194304, id)
    expect(reapStale(db())).toBe(1)
  })

  test('the reaper says WHY it swept, so routing can discount it', () => {
    // Without the kind these rows are indistinguishable from an agent that
    // simply failed, and the router charges them accordingly.
    const id = addRun({ agent: 'grok', job: 'craft', status: 'running' })
    db().query('UPDATE run SET pid=? WHERE id=?').run(4194304, id)
    reapStale(db())
    const r = db().query('SELECT status, failure_kind FROM run WHERE id=?')
      .get(id) as { status: string; failure_kind: 'interrupted' }
    expect(r.status).toBe('stale')
    expect(r.failure_kind).toBe('interrupted')
    expect(NOT_EVIDENCE).toContain(r.failure_kind)
  })

  test('a recent run with NO pid cannot be swept, which is why one is recorded', () => {
    // The liveness check is guarded on `if (r.pid)`, so a row without one is
    // invisible to it and can only be cleared by the thirty-minute cutoff. That
    // is not a bug in the reaper - a pid it never had tells it nothing - it is
    // the reason detach() must write the WORKER's pid the moment it spawns.
    // Without that, a worker that died before starting an agent left a row
    // claiming to run, showing `(pending)` on the dashboard; four were sitting
    // there when this was found, one for fifteen minutes.
    const id = addRun({ agent: 'grok', job: 'craft', status: 'running' })
    db().query('UPDATE run SET pid=NULL WHERE id=?').run(id)
    expect(reapStale(db())).toBe(0)
    // With one, the very same dead worker is swept on the next pass.
    db().query('UPDATE run SET pid=? WHERE id=?').run(4194304, id)
    expect(reapStale(db())).toBe(1)
  })

  test('a live recent run is left alone', () => {
    const id = addRun({ agent: 'grok', job: 'craft', status: 'running' })
    db().query('UPDATE run SET pid=? WHERE id=?').run(process.pid, id)
    expect(reapStale(db())).toBe(0)
  })

  test('a pid-less (pending) row older than the bootstrap bound is failed/harness', () => {
    const old = addRun({ agent: '(pending)', job: 'craft', status: 'running' })
    const young = addRun({ agent: '(pending)', job: 'craft', status: 'running' })
    db().query('UPDATE run SET pid=NULL, started_at=? WHERE id=?')
      .run(new Date(Date.now() - PENDING_BOOTSTRAP_MS - 1000).toISOString(), old)
    db().query('UPDATE run SET pid=NULL, started_at=? WHERE id=?')
      .run(new Date(Date.now() - 10_000).toISOString(), young)

    expect(reapStale(db())).toBe(1)
    const swept = db().query('SELECT status, failure_kind, error FROM run WHERE id=?')
      .get(old) as { status: string; failure_kind: string; error: string }
    expect(swept).toEqual({
      status: 'failed', failure_kind: 'harness', error: 'the worker process never started',
    })
    expect((db().query('SELECT status FROM run WHERE id=?').get(young) as { status: string }).status)
      .toBe('running')
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

describe('who may judge a run', () => {
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

describe('the scoring matrix', () => {
  test('no answer costs more than a wrong answer, because it is a different failure', () => {
    // A wrong answer means the agent engaged and got it wrong; nothing arriving
    // means it cannot do this job here. Only the second should push routing away.
    expect(weigh('none', null)).toBeLessThan(weigh('full', 'wrong'))
    expect(weigh('none', null)).toBeLessThan(0)
    expect(weigh('full', 'wrong')).toBe(0)
  })

  test('quality orders within a delivery level', () => {
    for (const d of ['partial', 'full'] as const) {
      expect(weigh(d, 'wrong')).toBeLessThan(weigh(d, 'mixed'))
      expect(weigh(d, 'mixed')).toBeLessThan(weigh(d, 'right'))
    }
  })

  test('a full answer beats the same quality delivered partially', () => {
    for (const q of ['wrong', 'mixed', 'right'] as const) {
      expect(weigh('partial', q)).toBeLessThanOrEqual(weigh('full', q))
    }
  })

  test('the three cells the old vocabulary could express kept their exact values', () => {
    // Migrating must not move any agent's standing on its own.
    expect(weigh('full', 'right')).toBe(1)     // was good
    expect(weigh('full', 'mixed')).toBe(0.5)   // was partial
    expect(weigh('full', 'wrong')).toBe(0)     // was bad
    expect(weigh('none', null)).toBe(-0.5)     // was unusable
  })

  test('the SQL expression is built from the matrix, so editing it moves routing', () => {
    const sql = weightCase()
    for (const [delivery, row] of Object.entries(WEIGHT)) {
      if (typeof row === 'number') {
        expect(sql).toContain(`WHEN s.delivery = '${delivery}' THEN ${row}`)
      } else {
        for (const [quality, w] of Object.entries(row)) {
          expect(sql).toContain(`WHEN s.delivery = '${delivery}' AND s.quality = '${quality}' THEN ${w}`)
        }
      }
    }
  })

  test('a delivery failure and a wrong answer are no longer the same row', () => {
    // The complaint that produced this matrix: run 279 came back as 57 bytes of
    // vendor error and was recorded identically to a full answer that was wrong.
    const noAnswer = addRun({ agent: 'agy', job: 'craft' })
    const wrongAnswer = addRun({ agent: 'codex', job: 'craft' })
    score(noAnswer, 'none')
    score(wrongAnswer, 'full', 'wrong')
    const cs = candidates('craft')
    expect(cs.find((c) => c.agent === 'agy')!.score)
      .toBeLessThan(cs.find((c) => c.agent === 'codex')!.score!)
  })

  test('the schema refuses an incoherent judgement', () => {
    const id = addRun({ agent: 'grok', job: 'craft' })
    // Nothing came back, yet a quality is asserted about it.
    expect(() => score(id, 'none', 'right')).toThrow()
    // Something came back, yet no quality is recorded.
    expect(() => score(id, 'full', null)).toThrow()
  })

  test('every cell has a short label, and none of them collide', () => {
    const labels = new Set<string>()
    labels.add(label('none', null))
    for (const d of ['partial', 'full'] as const)
      for (const q of ['wrong', 'mixed', 'right'] as const) labels.add(label(d, q))
    expect(labels.size).toBe(7)
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

describe('one score, reported the same everywhere', () => {
  function judged(agent: string, rights: number, wrongs: number) {
    for (let i = 0; i < rights; i++) {
      score(addRun({ agent, job: 'review-lens-inline' }), 'full', 'right')
    }
    for (let i = 0; i < wrongs; i++) {
      score(addRun({ agent, job: 'review-lens-inline' }), 'full', 'wrong')
    }
  }

  test('candidates shrink scores toward the mean of the proven field', () => {
    judged('codex', 4, 1)
    judged('grok', 31, 9)
    judged('agy', 0, 40)

    const cs = candidates('review-lens-inline')
    const codex = cs.find((c) => c.agent === 'codex')!
    const grok = cs.find((c) => c.agent === 'grok')!
    const agy = cs.find((c) => c.agent === 'agy')!
    const prior = (codex.score! + grok.score! + agy.score!) / 3

    expect(codex.score).toBeCloseTo(0.8)
    expect(codex.shrunk).toBeCloseTo((4 + MIN_SAMPLE * prior) / (5 + MIN_SAMPLE))
    expect(grok.shrunk).toBeCloseTo((31 + MIN_SAMPLE * prior) / (40 + MIN_SAMPLE))
    expect(agy.shrunk).toBeCloseTo((MIN_SAMPLE * prior) / (40 + MIN_SAMPLE))
  })

  test('shrinkage uses a 0.5 prior when the job has no proven agent', () => {
    judged('codex', 1, 0)
    const codex = candidates('review-lens-inline').find((c) => c.agent === 'codex')!
    expect(codex.score).toBe(1)
    expect(codex.shrunk).toBeCloseTo((1 + MIN_SAMPLE * 0.5) / (1 + MIN_SAMPLE))
  })

  test('pick and guide rank proven agents by shrunk score and report both means', () => {
    judged('codex', 4, 1)
    judged('grok', 31, 9)
    judged('agy', 0, 40)

    const routed = pick('review-lens-inline', undefined, 0, false)
    expect(routed.agent).toBe('grok')
    expect(routed.reason).toContain('78% (shrunk 75%) over 40 judged')

    const g = guide('review-lens-inline')[0]!
    expect(g.best!.agent).toBe('grok')
    expect(g.best!.score).toBeCloseTo(0.775)
    expect(g.best!.shrunk).toBeCloseTo(0.747222)
  })

  test('pick, guide, and stats print raw and shrunk scores, including a changed leader', () => {
    judged('codex', 4, 1)
    judged('grok', 31, 9)
    judged('agy', 0, 40)
    const cli = new URL('cli.ts', import.meta.url).pathname
    const runCli = (...args: string[]) => Bun.spawnSync([process.execPath, cli, ...args], {
      env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
      stdout: 'pipe', stderr: 'pipe',
    })

    const pickOut = new TextDecoder().decode(runCli('pick', 'review-lens-inline').stdout)
    const guideOut = new TextDecoder().decode(runCli('guide', '--job', 'review-lens-inline').stdout)
    const statsOut = new TextDecoder().decode(runCli('stats', '--job', 'review-lens-inline').stdout)
    expect(pickOut).toContain('78% (shrunk 75%) over 40 judged')
    expect(pickOut).toContain('score=78% shrunk=75%')
    expect(guideOut).toContain('78% raw,   75% shrunk')
    expect(guideOut).toContain('SHRUNK LEADER (raw: codex)')
    expect(statsOut).toContain('raw  shrunk')
    expect(statsOut).toContain('78%     75%')
  })

  test('the scoreboard is the router, not a second opinion', () => {
    // agy on review-lens: one good answer and two headless denials. The old
    // report filtered status='ok' and called that 100%; the router called it 0%.
    score(addRun({ agent: 'agy', job: 'review-lens' }), 'full', 'right')
    addRun({ agent: 'agy', job: 'review-lens', status: 'failed' })
    addRun({ agent: 'agy', job: 'review-lens', status: 'failed' })

    const fromRouter = candidates('review-lens').find((c) => c.agent === 'agy')!
    const fromBoard = scoreboard('review-lens').find((c) => c.agent === 'agy')!
    expect(fromBoard.score).toBe(fromRouter.score)
    expect(fromBoard.shrunk).toBe(fromRouter.shrunk)
    expect(fromBoard.evidence).toBe(fromRouter.evidence)
    expect(fromBoard.failures).toBe(2)
    // The number the report used to show, and the one it shows now.
    expect(fromBoard.score).toBe(0)
  })

  test('every cell in the scoreboard matches candidates() for its job', () => {
    score(addRun({ agent: 'grok', job: 'craft' }), 'full', 'right')
    addRun({ agent: 'codex', job: 'craft', status: 'stale' })
    score(addRun({ agent: 'grok', job: 'safety' }), 'full', 'mixed' )
    for (const cell of scoreboard()) {
      const c = candidates(cell.job).find((x) => x.agent === cell.agent)!
      expect(cell.score).toBe(c.score)
      expect(cell.shrunk).toBe(c.shrunk)
      expect(cell.evidence).toBe(c.evidence)
      expect(cell.runs).toBe(c.runs)
    }
  })

  test('a job filter narrows the rows without changing any of them', () => {
    score(addRun({ agent: 'grok', job: 'craft' }), 'full', 'right')
    addRun({ agent: 'grok', job: 'safety', status: 'failed' })
    const all = scoreboard()
    const one = scoreboard('craft')
    expect(one.every((r) => r.job === 'craft')).toBe(true)
    for (const r of one) {
      expect(all.find((x) => x.job === r.job && x.agent === r.agent)!.score).toBe(r.score)
    }
  })

  test('an agent with no history for a job is not a row at all', () => {
    // Absent, rather than present at zero — never asked is not the same as bad.
    expect(scoreboard('craft').find((r) => r.agent === 'agy')).toBeUndefined()
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

describe('retry keeps the work on the same agent', () => {
  test('a retry is linked to what it re-attempts', () => {
    const first = addRun({ agent: 'codex', job: 'review-lens', status: 'failed' })
    const second = addRun({ agent: 'codex', job: 'review-lens' })
    db().query('UPDATE run SET retry_of=? WHERE id=?').run(first, second)
    const row = db().query('SELECT retry_of FROM run WHERE id=?').get(second) as { retry_of: number }
    expect(row.retry_of).toBe(first)
  })

  test('a quota failure and its retry both count, because both really happened', () => {
    // A retry does not erase the failure. The agent did fail, and an hour of
    // routing avoided it for good reason; hiding that would flatter the record.
    const first = addRun({ agent: 'codex', job: 'craft', status: 'failed' })
    const second = addRun({ agent: 'codex', job: 'craft' })
    db().query('UPDATE run SET retry_of=? WHERE id=?').run(first, second)
    score(second, 'full', 'right')
    const c = candidates('craft').find((x) => x.agent === 'codex')!
    expect(c.failures).toBe(1)
    expect(c.scored).toBe(1)
    expect(c.evidence).toBe(2)
  })

  const CLI = new URL('cli.ts', import.meta.url).pathname
  const orch = (args: string[], extraEnv: Record<string, string> = {}) => {
    const p = Bun.spawnSync([process.execPath, CLI, ...args], {
      env: {
        ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
        CLAUDE_CODE_SESSION_ID: 'orch-test-session',
        ...extraEnv,
      },
      stdout: 'pipe', stderr: 'pipe',
    })
    return {
      code: p.exitCode,
      out: new TextDecoder().decode(p.stdout),
      err: new TextDecoder().decode(p.stderr),
    }
  }
  const occurrences = (hay: string, needle: string) => {
    let n = 0, i = 0
    while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length }
    return n
  }
  const boundBeside = (promptPath: string) => promptPath.replace(/\.prompt\.txt$/, '.bound.txt')

  test('a read-only run stores the caller prompt unwrapped and the bound prompt beside it', async () => {
    const agent = AGENTS.codex!
    const origBin = agent.bin
    const origArgv = agent.argv
    agent.bin = process.execPath
    agent.argv = () => ['-e', '']
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    const original = 'What does foo.ts do?'
    try {
      const result = await runJob({
        job: 'file-question', prompt: original, cwd: dir, agent: 'codex',
      })
      const row = db().query('SELECT prompt_path FROM run WHERE id=?').get(result.id) as
        { prompt_path: string }
      expect(readFileSync(row.prompt_path, 'utf8')).toBe(original)
      const bound = readFileSync(boundBeside(row.prompt_path), 'utf8')
      expect(occurrences(bound, READONLY_PREAMBLE)).toBe(1)
      expect(bound.endsWith(original)).toBe(true)
      expect(runDetail(result.id)?.prompt).toBe(original)
    } finally {
      agent.bin = origBin
      agent.argv = origArgv
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  })

  test('retry of a read-only run produces a child whose bound prompt contains the preamble exactly once', () => {
    const original = 'What does bar.ts do?'
    const promptPath = join(dir, 'retry-original.prompt.txt')
    writeFileSync(promptPath, original)
    const schemaPath = join(dir, 'retry-schema.json')
    writeFileSync(schemaPath, JSON.stringify({
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    }))
    const id = addRun({ agent: 'grok', job: 'file-question', status: 'failed' })
    db().query(
      `UPDATE run SET prompt_path=?, mcp=1, schema_path=?, model=?, cwd=? WHERE id=?`,
    ).run(promptPath, schemaPath, 'retry-model', dir, id)

    const binDir = mkdtempSync(join(tmpdir(), 'orch-fake-grok-retry-'))
    writeFileSync(join(binDir, 'grok'), '#!/bin/sh\necho ok\nexit 0\n')
    chmodSync(join(binDir, 'grok'), 0o755)
    try {
      const r = orch(['retry', String(id)], { PATH: `${binDir}:${process.env.PATH ?? ''}` })
      expect(r.code).toBe(0)
      const child = db().query(
        `SELECT id, prompt_path, mcp, schema_path, model, retry_of, agent
           FROM run WHERE retry_of=?`,
      ).get(id) as {
        id: number; prompt_path: string; mcp: number | null; schema_path: string | null
        model: string | null; retry_of: number; agent: string
      } | null
      expect(child).not.toBeNull()
      expect(child!.agent).toBe('grok')
      expect(child!.mcp).toBe(1)
      expect(child!.schema_path).toBe(schemaPath)
      expect(child!.model).toBe('retry-model')
      expect(readFileSync(child!.prompt_path, 'utf8')).toBe(original)
      const bound = readFileSync(boundBeside(child!.prompt_path), 'utf8')
      expect(occurrences(bound, READONLY_PREAMBLE)).toBe(1)
      expect(bound.endsWith(original)).toBe(true)
    } finally {
      rmSync(binDir, { recursive: true, force: true })
    }
  })

  test('retry of an implement run continues its session detached and prints the child id', () => {
    const binDir = mkdtempSync(join(tmpdir(), 'orch-fake-codex-retry-'))
    writeFileSync(join(binDir, 'codex'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(binDir, 'codex'), 0o755)
    const id = addRun({ agent: 'codex', job: 'implement', status: 'failed' })
    db().query('UPDATE run SET vendor_session=?, cwd=? WHERE id=?')
      .run('retry-session', dir, id)
    try {
      const r = orch(['retry', String(id)], { PATH: `${binDir}:${process.env.PATH ?? ''}` })
      expect(r.code).toBe(0)
      const childId = Number(r.out.trim().split('\n')[0])
      expect(childId).toBeGreaterThan(0)
      orch(['wait', String(childId), '--timeout', '15'])
      const child = db().query(
        'SELECT parent_run_id, turn, vendor_session FROM run WHERE id=?',
      ).get(childId) as {
        parent_run_id: number | null; turn: number; vendor_session: string | null
      }
      expect(child.parent_run_id).toBe(id)
      expect(child.turn).toBe(2)
      expect(child.vendor_session).toBe('retry-session')
    } finally {
      rmSync(binDir, { recursive: true, force: true })
    }
  })

  test('a writing retry refuses to change agents and directs a fresh start', () => {
    const id = addRun({ agent: 'grok', job: 'implement', status: 'failed' })
    db().query('UPDATE run SET vendor_session=?, cwd=? WHERE id=?')
      .run('retry-session', dir, id)
    const r = orch(['retry', String(id), '--agent', 'codex'])
    expect(r.code).toBe(1)
    expect(r.err).toContain(
      'a writing run continues on its own agent (grok); to start over on codex: ' +
      'orch do implement --agent codex ...',
    )
    expect(db().query('SELECT COUNT(*) n FROM run WHERE parent_run_id=?').get(id))
      .toEqual({ n: 0 })
  })

  test('orch do prints the reason an MCP exclusion could not be met', () => {
    const binDir = mkdtempSync(join(tmpdir(), 'orch-fake-grok-route-'))
    writeFileSync(join(binDir, 'grok'), '#!/bin/sh\necho ok\n')
    chmodSync(join(binDir, 'grok'), 0o755)
    try {
      const r = orch(
        ['do', 'mcp-query', 'answer', '--mcp', '--avoid', 'grok', '--follow'],
        { PATH: `${binDir}:${process.env.PATH ?? ''}` },
      )
      expect(r.code).toBe(0)
      expect(r.err).toContain(
        'excluded agents: codex: cannot make MCP tool calls without a writable sandbox',
      )
    } finally {
      rmSync(binDir, { recursive: true, force: true })
    }
  })

  test('retry and continue give the same refusal when the chain has no session', () => {
    for (const command of ['retry', 'continue']) {
      const id = addRun({ agent: 'codex', job: 'implement', status: 'failed' })
      const r = orch([command, String(id)])
      expect(r.code).toBe(1)
      expect(r.err).toContain(`run ${id} recorded no session id, so codex cannot be resumed`)
    }
  })
})

describe('a destroyed output is not evidence about the agent', () => {
  test('a scored collision is kept as a verdict and dropped from routing', () => {
    // The score stays: a person did judge what they were shown. It simply
    // stops counting, because what they were shown was another run's work.
    const kept = addRun({ agent: 'codex', job: 'review-lens' })
    score(kept, 'full', 'right')
    const a = addRun({ agent: 'codex', job: 'review-lens' })
    const b = addRun({ agent: 'codex', job: 'review-lens' })
    score(a, 'none')
    score(b, 'none')
    db().query("UPDATE run SET evidence_excluded='shared an output file' WHERE id IN (?,?)")
      .run(a, b)

    const c = candidates('review-lens').find((x) => x.agent === 'codex')!
    expect(c.scored).toBe(1)
    expect(c.evidence).toBe(1)
    expect(c.score).toBe(weigh('full', 'right'))
    const n = (db().query('SELECT COUNT(*) n FROM score').get() as { n: number }).n
    expect(n).toBe(3)
  })

  test('the backfill stamps every member of a colliding group, and no unique path', () => {
    const shared = join(dir, 'collided.txt')
    const unique = join(dir, 'alone.txt')
    const a = addRun({ agent: 'codex', job: 'review-lens' })
    const b = addRun({ agent: 'codex', job: 'review-lens' })
    const c = addRun({ agent: 'codex', job: 'review-lens' })
    db().query('UPDATE run SET output_path=? WHERE id IN (?,?)').run(shared, a, b)
    db().query('UPDATE run SET output_path=? WHERE id=?').run(unique, c)
    expect(excludeSharedOutputRuns(db())).toBe(2)
    const rows = db().query(
      'SELECT id, evidence_excluded AS why FROM run WHERE id IN (?,?,?) ORDER BY id',
    ).all(a, b, c) as { id: number; why: string | null }[]
    expect(rows.find((r) => r.id === a)!.why).toBe(SHARED_OUTPUT_REASON)
    expect(rows.find((r) => r.id === b)!.why).toBe(SHARED_OUTPUT_REASON)
    expect(rows.find((r) => r.id === c)!.why).toBeNull()
  })

  test('a reason already written is left alone', () => {
    const shared = join(dir, 'already.txt')
    const a = addRun({ agent: 'codex', job: 'review-lens' })
    const b = addRun({ agent: 'codex', job: 'review-lens' })
    db().query('UPDATE run SET output_path=? WHERE id IN (?,?)').run(shared, a, b)
    db().query("UPDATE run SET evidence_excluded='already set' WHERE id=?").run(a)
    expect(excludeSharedOutputRuns(db())).toBe(1)
    const why = db().query(
      'SELECT evidence_excluded AS why FROM run WHERE id=?',
    ).get(a) as { why: string }
    expect(why.why).toBe('already set')
  })

  test('orch result says so on the record a person would score from', () => {
    const CLI = new URL('cli.ts', import.meta.url).pathname
    const id = addRun({ agent: 'codex', job: 'review-lens' })
    db().query("UPDATE run SET evidence_excluded='shared an output file' WHERE id=?").run(id)
    const p = Bun.spawnSync([process.execPath, CLI, 'result', String(id)], {
      env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
      stdout: 'pipe', stderr: 'pipe',
    })
    const err = new TextDecoder().decode(p.stderr)
    expect(p.exitCode).toBe(0)
    expect(err).toContain('not routing evidence: shared an output file')
  })
})

describe('a probe proves an agent is alive without vouching for it', () => {
  test('a probe clears a cooldown, which is the only way to clear one early', () => {
    // Deliberate, and the one query that does not filter probes. Availability
    // is not quality: a human who tops up a quota needs a way to say so.
    const failed = addRun({ agent: 'codex', job: 'craft', status: 'failed' })
    db().query("UPDATE run SET failure_kind='quota' WHERE id=?").run(failed)
    expect(candidates('craft').find((c) => c.agent === 'codex')!.cooling).toContain('quota')

    addRun({ agent: 'codex', job: 'craft', probe: 1 })  // succeeded, calibration
    expect(candidates('craft').find((c) => c.agent === 'codex')!.cooling).toBeNull()
  })

  test('but the probe still teaches routing nothing', () => {
    score(addRun({ agent: 'codex', job: 'safety', probe: 1 }), 'full', 'right')
    const c = candidates('safety').find((x) => x.agent === 'codex')!
    expect(c.evidence).toBe(0)
    expect(c.score).toBeNull()
  })
})

describe('the noise band', () => {
  test('is one judgement step over MIN_SAMPLE, which is what its comment claims', () => {
    expect(QUALITY_STEP).toBe(weigh('full', 'right') - weigh('full', 'mixed'))
    expect(NOISE_BAND).toBeCloseTo(QUALITY_STEP / MIN_SAMPLE)
    expect(NOISE_BAND).toBeCloseTo(0.1)
  })

  test('it is NOT the full spread of the scale, which is a different question', () => {
    // A review lens proposed (WEIGHT_MAX - weigh('none')) / MIN_SAMPLE / 2 =
    // 0.15. That measures the whole scale; the band measures one judgement.
    const spread = weigh('full', 'right') - weigh('none', null)
    expect(spread).toBe(1.5)
    expect(NOISE_BAND).not.toBeCloseTo(spread / MIN_SAMPLE / 2)
  })

  test('it tracks the matrix rather than a constant that happens to match', () => {
    // The old derivation was WEIGHT_MAX / MIN_SAMPLE / 2. It agreed only
    // because WEIGHT_MAX/2 and one quality step are both 0.5 today.
    const coincidence = 1 / MIN_SAMPLE / 2
    expect(NOISE_BAND).toBeCloseTo(coincidence)          // same number now
    expect(QUALITY_STEP).not.toBe(1 / 2 + 0.0001)        // but derived differently
  })
})

describe('routing exploration', () => {
  test('a wrong answer stays explorable, while delivery-none-only history does not', () => {
    for (let i = 0; i < MIN_SAMPLE; i++) {
      score(addRun({ agent: 'codex', job: 'review-lens' }), 'full', 'right')
    }
    const wrong = addRun({ agent: 'grok', job: 'review-lens' })
    score(wrong, 'full', 'wrong')

    const random = Math.random
    Math.random = () => 0
    try {
      expect(pick('review-lens').agent).toBe('grok')
      db().query("UPDATE score SET delivery='none', quality=NULL WHERE run_id=?").run(wrong)
      expect(pick('review-lens').agent).toBe('codex')
    } finally {
      Math.random = random
    }
  })

  test('the standing draw picks a proven non-leader', () => {
    for (let i = 0; i < MIN_SAMPLE; i++) {
      score(addRun({ agent: 'codex', job: 'review-lens' }), 'full', 'right')
      score(addRun({ agent: 'grok', job: 'review-lens' }), 'full', 'mixed')
    }

    const random = Math.random
    Math.random = () => STANDING_EXPLORE_RATE / 2
    try {
      const routed = pick('review-lens')
      expect(routed.agent).toBe('grok')
      expect(routed.reason).toContain('standing challenger')
    } finally {
      Math.random = random
    }
  })
})

describe('routing evidence scope', () => {
  test('only the most recent evidence window counts in candidates and the scoreboard', () => {
    for (let i = 0; i < 5; i++) {
      score(addRun({ agent: 'codex', job: 'review-lens' }), 'full', 'wrong')
    }
    for (let i = 0; i < EVIDENCE_WINDOW; i++) {
      score(addRun({ agent: 'codex', job: 'review-lens' }), 'full', 'right')
    }

    const candidate = candidates('review-lens').find((c) => c.agent === 'codex')!
    const cell = scoreboard('review-lens').find((c) => c.agent === 'codex')!
    expect(candidate.evidence).toBe(EVIDENCE_WINDOW)
    expect(candidate.score).toBe(1)
    expect(cell.evidence).toBe(EVIDENCE_WINDOW)
    expect(cell.score).toBe(candidate.score)
  })

  test('current-model evidence is used at MIN_SAMPLE and otherwise falls back across models', () => {
    const current = AGENTS.codex!.model
    for (let i = 0; i < MIN_SAMPLE; i++) {
      score(addRun({ agent: 'codex', job: 'review-lens', model: 'older-model' }), 'full', 'wrong')
    }
    for (let i = 0; i < MIN_SAMPLE - 1; i++) {
      score(addRun({ agent: 'codex', job: 'review-lens', model: current }), 'full', 'right')
    }

    let candidate = candidates('review-lens').find((c) => c.agent === 'codex')!
    expect(candidate.evidence).toBe(MIN_SAMPLE * 2 - 1)
    expect(candidate.evidenceModel).toBeNull()
    expect(pick('review-lens', undefined, 0, false).reason).toContain('across models')

    score(addRun({ agent: 'codex', job: 'review-lens', model: current }), 'full', 'right')
    candidate = candidates('review-lens').find((c) => c.agent === 'codex')!
    expect(candidate.evidence).toBe(MIN_SAMPLE)
    expect(candidate.score).toBe(1)
    expect(candidate.evidenceModel).toBe(current)
    expect(pick('review-lens', undefined, 0, false).reason).toContain(`on model ${current}`)
  })
})

describe('what counts as unscored', () => {
  test('only a successful, non-probe, unjudged run is owed a judgement', () => {
    addRun({ agent: 'grok', job: 'craft' })                          // owed
    addRun({ agent: 'grok', job: 'craft', probe: 1 })                // calibration
    addRun({ agent: 'grok', job: 'craft', status: 'failed' })        // already none
    addRun({ agent: 'grok', job: 'craft', status: 'stale' })         // already none
    addRun({ agent: 'grok', job: 'craft', status: 'running' })       // not finished
    score(addRun({ agent: 'grok', job: 'craft' }), 'full', 'right')  // judged

    // `runs - scores` — what doctor and the card used to do — would say 5.
    expect(unscoredCount()).toBe(1)
  })

  test('doctor and pending cannot disagree, because they share the rule', () => {
    const mine = addRun({ agent: 'grok', job: 'craft' })
    db().query('UPDATE run SET session_id=? WHERE id=?').run('S', mine)
    addRun({ agent: 'grok', job: 'craft', status: 'failed' })
    expect(pendingForSession('S').length).toBe(1)
    expect(unscoredCount()).toBe(1)
  })

  test('the count honours the dashboard window', () => {
    const old = addRun({ agent: 'grok', job: 'craft' })
    db().query('UPDATE run SET started_at=? WHERE id=?')
      .run(new Date(Date.now() - 60 * 86_400_000).toISOString(), old)
    addRun({ agent: 'grok', job: 'craft' })
    expect(unscoredCount()).toBe(2)
    expect(unscoredCount(new Date(Date.now() - 7 * 86_400_000).toISOString())).toBe(1)
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
                      prompt_path=?, output_path=?, run_token=? WHERE id=?`,
    ).run(5678, 'timeout', 'not evidence', 'timed out', promptPath, outputPath, 'secret', id)
    score(id, 'partial', 'mixed')
    db().query('UPDATE score SET note=? WHERE run_id=?').run('read by hub', id)

    const detail = runDetail(id)!
    expect(detail).toMatchObject({
      id, agent: 'grok', job: 'craft', latency_ms: 1234, vendor_tokens: 5678,
      status: 'failed', failure_kind: 'timeout', probe: 1,
      evidence_excluded: 'not evidence', error: 'timed out',
      delivery: 'partial', quality: 'mixed', note: 'read by hub',
      prompt: 'the whole prompt', output: 'the whole reply',
    })
    expect(detail).not.toHaveProperty('run_token')
  })
})

 describe('median', () => {
  test('there is one implementation, and the guide uses it', () => {
    // Two identical copies lived in route.ts and guide.ts. Identical today is
    // how a pair of copies always starts.
    expect(median([])).toBeNull()
    expect(median([5])).toBe(5)
    expect(median([3, 1, 2])).toBe(2)          // odd: middle after sorting
    expect(median([4, 1, 3, 2])).toBe(2.5)     // even: mean of the middle two
  })

  test('it does not disturb the array it is given', () => {
    const xs = [3, 1, 2]
    median(xs)
    expect(xs).toEqual([3, 1, 2])
  })

  test('one hung call does not move it, which is why it is not a mean', () => {
    const withHang = [100, 110, 120, 130, 900_000]
    expect(median(withHang)).toBe(120)
  })
})

describe('the activity window', () => {
  /** A run backdated by `days`, so the window has something to exclude. */
  function agedRun(days: number, o: { agent: string; job: string; status?: string }) {
    const id = addRun(o)
    db().query('UPDATE run SET started_at=? WHERE id=?')
      .run(new Date(Date.now() - days * 86_400_000).toISOString(), id)
    return id
  }

  test('the counters exclude runs outside the window', () => {
    agedRun(60, { agent: 'grok', job: 'craft', status: 'failed' })   // long ago
    agedRun(0, { agent: 'grok', job: 'craft', status: 'failed' })    // just now

    expect((state(null).totals as { failed: number }).failed).toBe(2)
    expect((state(30).totals as { failed: number }).failed).toBe(1)
    expect((state(1).totals as { failed: number }).failed).toBe(1)
  })

  test('the scored counter excludes judgements on not-evidence runs', () => {
    score(agedRun(0, { agent: 'grok', job: 'craft' }), 'full', 'right')
    const interrupted = agedRun(0, { agent: 'grok', job: 'craft', status: 'failed' })
    db().query("UPDATE run SET failure_kind='interrupted' WHERE id=?").run(interrupted)
    score(interrupted, 'none')

    expect((state(null).totals as { scored: number }).scored).toBe(1)
  })

  test('a fix can actually show up, which is the point of windowing at all', () => {
    // Nine stale runs all predate the try/finally. On a lifetime counter they
    // would announce that bug for ever; on a window they age out and the
    // counter starts telling the truth again.
    agedRun(10, { agent: 'grok', job: 'craft', status: 'stale' })
    expect((state(null).totals as { stale_n: number }).stale_n).toBe(1)
    // Zero, not null. SUM over no rows is NULL in SQLite while COUNT is 0, so
    // an empty window used to answer `failed: null` beside `runs: 0`.
    expect((state(7).totals as { stale_n: number }).stale_n).toBe(0)
  })

  test('the routing matrix is NOT windowed, whatever the band shows', () => {
    // The evidence base. A matrix narrowed to 24 hours would report an agent
    // has no runs while the router is confidently using twenty-six of them.
    score(agedRun(60, { agent: 'grok', job: 'craft' }), 'full', 'right')
    for (const days of [null, 30, 7, 1]) {
      expect((state(days).matrix as unknown[]).length).toBe(1)
    }
  })

  test('the runs-tab badge stays lifetime, so it does not change meaning', () => {
    agedRun(60, { agent: 'grok', job: 'craft' })
    agedRun(0, { agent: 'grok', job: 'craft' })
    expect(state(1).allTimeRuns).toBe(2)
    expect((state(1).totals as { runs: number }).runs).toBe(1)
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

describe('a vendor error is not an answer', () => {
  test("Qwen Code's empty-stream placeholder is recognised", () => {
    // Run 279, verbatim: exit 0, 57 bytes, recorded as a success for 409s and
    // 325k vendor tokens until a person read it.
    expect(isNonAnswer('[API Error: Model stream ended with empty response text.]')).toBe(true)
  })

  test('an empty reply is not an answer either', () => {
    expect(isNonAnswer('')).toBe(true)
    expect(isNonAnswer('   \n  ')).toBe(true)
  })

  test('a Grok streaming transcript is not an answer', () => {
    const transcript = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'trimmed' }),
      JSON.stringify({ type: 'result', subtype: 'error_during_execution', errors: ['cancelled'] }),
    ].join('\n')
    expect(isNonAnswer(transcript)).toBe(true)
  })

  test('a real answer that DISCUSSES an API error is kept', () => {
    // A review of this very code would quote that string; throwing the reply
    // away because it mentions one would be worse than the bug.
    expect(isNonAnswer('The handler swallows [API Error: ...] and stores it as the reply.')).toBe(false)
    expect(isNonAnswer('No findings. The API error path is covered.')).toBe(false)
  })
})

describe('reachability is a routing input, not a run outcome', () => {
  // Restored after every test in here: a null cache is the permissive default,
  // which is exactly the state the rest of the suite expects.
  afterEach(() => resetLocalHealth())

  test('an endpoint nothing is listening on is not reachable', async () => {
    // Port 1 is refused immediately on any machine, so this is fast and does
    // not depend on the local model host being up — or down.
    const r = await localReachable(2000, 'http://127.0.0.1:1/v1')
    expect(r.ok).toBe(false)
  })

  test('a 200 from the wrong service is not reachability', async () => {
    // The gotcha that cost real time: local 8000 is Docker Desktop's, and it
    // answers HTTP 200 with HTML. Status alone would have called that healthy.
    const srv = Bun.serve({
      port: 0,
      fetch: () => new Response('<html>hello</html>', {
        headers: { 'content-type': 'text/html' },
      }),
    })
    try {
      const r = await localReachable(2000, `http://127.0.0.1:${srv.port}/v1`)
      expect(r.ok).toBe(false)
      expect(r.detail).toContain('something else owns this port')
    } finally { srv.stop(true) }
  })

  test('JSON that is not a model list is not an OpenAI endpoint either', async () => {
    const srv = Bun.serve({ port: 0, fetch: () => Response.json({ hello: 'world' }) })
    try {
      const r = await localReachable(2000, `http://127.0.0.1:${srv.port}/v1`)
      expect(r.ok).toBe(false)
    } finally { srv.stop(true) }
  })

  test('a dead endpoint makes the local agent unavailable, not "not installed"', async () => {
    // The whole fix in one assertion. `available()` used to check only that the
    // endpoint was CONFIGURED, which stayed true for every one of the eleven
    // hours the local model host was powered off — so routing kept sending it work.
    await ensureLocalHealth({ force: true, baseUrl: 'http://127.0.0.1:1/v1' })

    const local = Object.values(AGENTS).find((a) => a.billing === 'local')!
    expect(available(local.name)).toBe(false)
    const why = unavailableReason(local.name)!
    expect(why).toContain('unreachable')
    // And specifically NOT the answer it used to give, which sends you looking
    // for a binary that is sitting right there on PATH.
    expect(why).not.toContain('not installed')
  })

  test('an unreachable endpoint excludes the agent from routing, with the reason', async () => {
    await ensureLocalHealth({ force: true, baseUrl: 'http://127.0.0.1:1/v1' })
    const local = Object.values(AGENTS).find((a) => a.billing === 'local')!
    // file-question is the job it is best at and would otherwise be preferred.
    const c = candidates('file-question').find((x) => x.agent === local.name)!
    expect(c.eligible).toBe(false)
    expect(c.why).toContain('unreachable')
  })

  test('every command that reports a route also checks reachability', () => {
    // `orch do` probed and `orch pick` did not, so during the outage they gave
    // different answers for the same job: pick said qwen-local, do said codex.
    // These four report a route and must all be covered.
    for (const cmd of ['do', 'pick', 'guide', 'doctor']) {
      expect(NEEDS_HEALTH.has(cmd)).toBe(true)
    }
    // History does not change when a machine is switched off, so `stats` is
    // deliberately out — this pins the intent, not just the contents.
    expect(NEEDS_HEALTH.has('stats')).toBe(false)
  })

  test('waking is opt-in: no MAC, no packet, ever', () => {
    // The local model host may be shared. A tool that powers it on by
    // default is making a decision that is not its to make.
    const d = wakeDecision({ mac: '', haveBinary: true, last: null, now: Date.now() })
    expect(d.send).toBe(false)
    expect(d.detail).toContain('opt-in')
  })

  test('a configured MAC with the tool present sends exactly one packet', () => {
    const d = wakeDecision({
      mac: '02:00:00:00:00:01', haveBinary: true, last: null, now: Date.now(),
    })
    expect(d.send).toBe(true)
    expect(d.detail).toContain('02:00:00:00:00:01')
  })

  test('a missing wakeonlan is reported, not silently skipped', () => {
    const d = wakeDecision({
      mac: '02:00:00:00:00:01', haveBinary: false, last: null, now: Date.now(),
    })
    expect(d.send).toBe(false)
    expect(d.detail).toContain('brew install')
  })

  test('a second packet inside a cold start is refused', () => {
    // Measured cold start is 5m42s. Sending again at four minutes cannot make
    // the model load faster; it only turns one wake into a stream of them.
    const now = Date.now()
    const soon = wakeDecision({
      mac: '02:00:00:00:00:01', haveBinary: true,
      last: new Date(now - 4 * 60_000), now,
    })
    expect(soon.send).toBe(false)
    expect(soon.detail).toContain('4m ago')

    // And allowed again once the whole boot has had its chance.
    const later = wakeDecision({
      mac: '02:00:00:00:00:01', haveBinary: true,
      last: new Date(now - WAKE_COOLDOWN_MS - 1000), now,
    })
    expect(later.send).toBe(true)
  })

  test('the cooldown is longer than the boot it is waiting for', () => {
    // 5m42s measured, power-on to "Application startup complete", before
    // firmware POST. A cooldown under that would always fire mid-boot.
    expect(WAKE_COOLDOWN_MS).toBeGreaterThan(5 * 60_000 + 42_000)
  })

  test('an unprobed cache leaves every caller exactly as it was', () => {
    // Reporting views are synchronous and never probe. They must not start
    // calling a configured agent absent just because nobody asked.
    resetLocalHealth()
    const local = Object.values(AGENTS).find((a) => a.billing === 'local')!
    const why = unavailableReason(local.name)
    expect(why === null || !why.includes('unreachable')).toBe(true)
  })
})

describe('a job only goes to an agent that can hold it', () => {
  // Deliberately NOT asserting which jobs qwen-local can take today. That is a
  // serving parameter — it was 65,536 and is now 131,072 — and a test pinned to
  // it fails when someone re-serves the model, which is a configuration change
  // and not a regression. The RULE is what must hold.
  const windowOf = (name: string) => AGENTS[name]!.contextTokens
  const needOf = (job: string) => JOBS[job]!.contextTokens

  test('an agent is excluded unless its window holds the working set AND a reply', () => {
    for (const job of Object.keys(JOBS)) {
      for (const name of Object.keys(AGENTS)) {
        const c = candidates(job).find((x) => x.agent === name)!
        const tooSmall = windowOf(name) < needOf(job) + OUTPUT_RESERVE
        if (tooSmall) {
          expect(c.eligible).toBe(false)
          expect(c.why).toContain('context')
        } else if (!c.eligible) {
          // Excluded for some other reason, which is fine — but not this one.
          expect(c.why).not.toContain('context')
        }
      }
    }
  })

  test('the reason names both numbers, so it can be acted on', () => {
    const fits = (n: string, j: string) => windowOf(n) >= needOf(j) + OUTPUT_RESERVE
    const tight = Object.keys(AGENTS).find((n) =>
      Object.keys(JOBS).some((j) => !fits(n, j)))
    if (!tight) return  // every agent currently holds every job
    const job = Object.keys(JOBS).find((j) => !fits(tight, j))!
    const c = candidates(job).find((x) => x.agent === tight)!
    expect(c.why).toMatch(/\d+K context is short of the ~\d+K/)
  })

  test('a job nobody can hold excludes everybody, so the rule can actually bite', () => {
    // The rule has to be capable of refusing every agent, or it is decoration.
    const biggest = Math.max(...Object.values(AGENTS).map((a) => a.contextTokens))
    const impossible = biggest === Number.POSITIVE_INFINITY ? null : biggest + 1
    if (impossible === null) {
      // Every agent declares no ceiling; nothing to prove today.
      expect(Object.values(AGENTS).some((a) => a.contextTokens === Number.POSITIVE_INFINITY)).toBe(true)
      return
    }
    expect(Object.values(AGENTS).every((a) => a.contextTokens < impossible)).toBe(true)
  })

  test('the local model is the one with a measured ceiling; the rest declare none', () => {
    // If this ever flips, someone has copied a number off a spec sheet.
    expect(windowOf('qwen-local')).toBeLessThan(Number.POSITIVE_INFINITY)
    for (const n of ['codex', 'grok', 'agy']) {
      expect(windowOf(n)).toBe(Number.POSITIVE_INFINITY)
    }
  })
})

describe('every agent is bounded', () => {
  test('no agent may outlive the stale cutoff, or it is reaped mid-run', () => {
    for (const a of Object.values(AGENTS)) {
      expect(a.timeoutMs).toBeGreaterThan(0)
      expect(a.timeoutMs).toBeLessThan(STALE_AFTER_MS)
    }
  })
})

/**
 * `orch wait` and `orch result` are the collection half of `--detach`, and
 * another session's fan-out now depends on their exit codes meaning what they
 * say. Driven through the real CLI, because the bugs worth catching here are in
 * argument parsing and process exit status, neither of which a unit call sees.
 */
describe('a read-only job never gets a writable disk', () => {
  /**
   * One session had seven files of uncommitted review fixes in its
   * checkout. A review lens ran there with --mcp — read-only jobs cut no
   * worktree, so they run in the caller's tree — and codex's --approve-for-me
   * implies workspace-write. The tree came back at HEAD, no stash, no commit,
   * nothing in the reflog, and the run reported that it "remains clean".
   */
  test('routing refuses an agent whose tools require a writable sandbox', () => {
    expect(() => pick('review-lens', 'codex', 0, false, null, true))
      .toThrow(/writable sandbox/)
  })

  test('the same agent is fine for that job without tools', () => {
    expect(pick('review-lens', 'codex', 0, false, null, false).agent).toBe('codex')
  })

  test('destroyed work is reported, not just new files', () => {
    // dirtiedTree only ever reported lines that APPEARED, so a run that created
    // a stray file was caught and one that reverted the tree was not. Absence
    // was the whole signal and it was the half being ignored.
    const before = ' M hub/src/a.ts\n M hub/src/b.ts'
    const after = ''
    const lines = (x: string) => x.split('\n').filter((l) => l.trim())
    const was = new Set(lines(before))
    const now = new Set(lines(after))
    const gone = [...was].filter((l) => !now.has(l))
    expect(gone).toHaveLength(2)
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

describe('hooks fail open visibly', () => {
  const runHook = (name: string, input: string) => Bun.spawnSync(
    ['python3', new URL(`../hooks/${name}`, import.meta.url).pathname],
    { stdin: new TextEncoder().encode(input), stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, ORCH_DB: process.env.ORCH_DB! } },
  )

  test('malformed stdin exits zero and writes one stderr line', () => {
    for (const hook of ['block-agent.py', 'score-reminder.py']) {
      const p = runHook(hook, '{not json')
      expect(p.exitCode).toBe(0)
      const lines = p.stderr.toString().trim().split('\n')
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('payload could not be parsed')
    }
    const fallback = new URL('../spawn-fallback.log', import.meta.url).pathname
    expect(readFileSync(fallback, 'utf8').trim().split('\n').at(-1))
      .toContain('payload could not be parsed')
  })

  test('NEEDS-WEB deep in a prompt is not a declaration', () => {
    const prompt = 'x'.repeat(500) + ' NEEDS-WEB'
    const p = runHook('block-agent.py', JSON.stringify({
      hook_event_name: 'PreToolUse', tool_name: 'Agent',
      tool_input: { description: 'read files', prompt, subagent_type: 'general-purpose' },
    }))
    expect(p.exitCode).toBe(0)
    const reply = JSON.parse(p.stdout.toString())
    expect(reply.hookSpecificOutput.permissionDecision).toBe('deny')
  })
})

describe('metric canon headline and calendar halves', () => {
  test('headline uses canon totals and excluded days do not move the midpoint', () => {
    const day = (ago: number) => {
      const d = new Date()
      d.setDate(d.getDate() - ago)
      const y = d.getFullYear()
      const m = String(d.getMonth() + 1).padStart(2, '0')
      return `${y}-${m}-${String(d.getDate()).padStart(2, '0')}`
    }
    const insert = db().query(
      `INSERT INTO metric (day, claude_tokens, cache_read, messages, tasks,
                           canon_tokens, other_tokens, collected_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    for (const [ago, canon, other, tasks] of [
      [13, 300, 30, 3], [12, 300, 30, 3], [10, 1, 0, 100],
      [2, 150, 15, 3], [1, 150, 15, 3],
    ]) insert.run(day(ago), canon + other, 0, 1, tasks, canon, other, new Date().toISOString())

    const s = summary(14)
    expect(s.canonTokens).toBe(900)
    expect(s.tokens).toBe(990)
    expect(s.otherTokens).toBe(90)
    expect(s.perTask).toBe(75)
    expect(s.earlier).toEqual({ tokens: 600, tasks: 6, perTask: 100 })
    expect(s.recent).toEqual({ tokens: 300, tasks: 6, perTask: 50 })
    expect(s.direction).toBe('improving')
    db().exec('DELETE FROM metric')
  })
})

describe('recalibrating the scorer', () => {
  const CLI = new URL('cli.ts', import.meta.url).pathname
  const runRecalibrate = (input: string, ...args: string[]) => {
    const p = Bun.spawnSync([process.execPath, CLI, 'recalibrate', ...args], {
      env: {
        ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
        CLAUDE_CODE_SESSION_ID: 'calibration-session',
      },
      stdin: new TextEncoder().encode(input), stdout: 'pipe', stderr: 'pipe',
    })
    return {
      code: p.exitCode,
      out: new TextDecoder().decode(p.stdout),
      err: new TextDecoder().decode(p.stderr),
    }
  }
  const oldScore = (
    runId: number, delivery: string, quality: string | null, fidelity: string | null,
    scorer = 'claude', scoredAt = '2026-01-01T00:00:00.000Z',
  ) => db().query(
    `INSERT INTO score (run_id, delivery, quality, fidelity, scored_at, scored_by)
     VALUES (?,?,?,?,?,?)`,
  ).run(runId, delivery, quality, fidelity, scoredAt, scorer)

  test('blind verdicts are stored apart and kappa is printed per comparable axis', () => {
    const originals = [
      ['none', null, null],
      ['partial', 'wrong', 'drifted'],
      ['full', 'right', 'faithful'],
    ] as const
    for (const [i, original] of originals.entries()) {
      const id = addRun({ agent: 'codex', job: 'implement' })
      const output = join(dir, `calibration-${i}.txt`)
      writeFileSync(output, `answer ${i}`)
      db().query('UPDATE run SET output_path=? WHERE id=?').run(output, id)
      oldScore(id, original[0], original[1], original[2])
    }

    const r = runRecalibrate('full right faithful\nfull right faithful\nfull right faithful\n', '--n', '3')
    expect(r.code).toBe(0)
    expect(r.err).toBe('')
    expect(r.out).toContain('axes: delivery quality fidelity')
    expect(r.out).toContain('delivery: n=3 kappa=0.000 reading=ambiguous rubric')
    expect(r.out).toContain('quality: n=2 kappa=0.000 reading=ambiguous rubric')
    expect(r.out).toContain('fidelity: n=2 kappa=0.000 reading=ambiguous rubric')
    expect(db().query(
      `SELECT delivery, quality, fidelity, session_id FROM calibration ORDER BY id`,
    ).all()).toEqual(Array.from({ length: 3 }, () => ({
      delivery: 'full', quality: 'right', fidelity: 'faithful',
      session_id: 'calibration-session',
    })))
    expect(db().query(
      'SELECT delivery, quality, fidelity FROM score ORDER BY id',
    ).all()).toEqual(originals.map(([delivery, quality, fidelity]) => ({ delivery, quality, fidelity })))
  })

  test('age and scorer identity filter the sample, while force skips only identity', () => {
    const foreign = addRun({ agent: 'codex', job: 'file-question' })
    const foreignOut = join(dir, 'calibration-foreign.txt')
    writeFileSync(foreignOut, 'foreign output')
    db().query('UPDATE run SET output_path=? WHERE id=?').run(foreignOut, foreign)
    oldScore(foreign, 'full', 'right', null, 'someone-else')

    const recent = addRun({ agent: 'codex', job: 'file-question' })
    const recentOut = join(dir, 'calibration-recent.txt')
    writeFileSync(recentOut, 'recent output')
    db().query('UPDATE run SET output_path=? WHERE id=?').run(recentOut, recent)
    oldScore(recent, 'full', 'right', null, 'claude', new Date().toISOString())

    const missing = addRun({ agent: 'codex', job: 'file-question' })
    db().query('UPDATE run SET output_path=? WHERE id=?').run('/definitely/missing/DEV-86', missing)
    oldScore(missing, 'full', 'right', null)

    const filtered = runRecalibrate('')
    expect(filtered.code).toBe(0)
    expect(filtered.out).toContain('no scored runs older than 7 days with output still on disk')
    const forced = runRecalibrate('full right\n', '--force', '--n', '1')
    expect(forced.code).toBe(0)
    expect(forced.out).toContain('foreign output')
    expect(forced.out).not.toContain('recent output')
    expect((db().query('SELECT COUNT(*) AS n FROM calibration').get() as { n: number }).n).toBe(1)
  })

  test('the displayed output keeps the first 4000 and last 2000 characters', () => {
    const id = addRun({ agent: 'codex', job: 'file-question' })
    const output = join(dir, 'calibration-long.txt')
    writeFileSync(output, 'H'.repeat(4000) + 'M'.repeat(50) + 'T'.repeat(2000))
    db().query('UPDATE run SET output_path=? WHERE id=?').run(output, id)
    oldScore(id, 'partial', 'mixed', null)
    const r = runRecalibrate('partial mixed\n', '--n', '1')
    expect(r.code).toBe(0)
    expect(r.out).toContain('H'.repeat(4000))
    expect(r.out).toContain('T'.repeat(2000))
    expect(r.out).not.toContain('M'.repeat(50))
    expect(r.out).not.toContain('original_delivery')
  })
})

describe('detached run collection', () => {
  const CLI = new URL('cli.ts', import.meta.url).pathname
  const orch = (...args: string[]) => {
    const p = Bun.spawnSync([process.execPath, CLI, ...args], {
      // The suite may itself be run by an orch worker. CLI behavior under test
      // starts at the user boundary, not at the inherited delegation depth.
      env: {
        ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
        CLAUDE_CODE_SESSION_ID: 'orch-test-session',
      },
      stdout: 'pipe', stderr: 'pipe',
    })
    return {
      code: p.exitCode,
      out: new TextDecoder().decode(p.stdout),
      err: new TextDecoder().decode(p.stderr),
    }
  }
  const insert = (status: string, job = 'file-question') => (db().query(
    `INSERT INTO run (started_at, agent, job, prompt_sha, prompt_bytes, prompt_head, status)
     VALUES (?, 'codex', ?, 'x', 1, 'x', ?) RETURNING id`,
  ).get(new Date().toISOString(), job, status) as { id: number }).id

  test('the detached spec mapping forwards every field to run', () => {
    const resume = {
      parent: 11, agent: 'codex', session: 'session', turn: 2, sessionId: 'owner',
      worktree: { path: '/tmp/tree', branch: 'DEV-63', base: 'main', repoRoot: '/tmp/repo' },
    }
    expect(detachedRunOptions('implement', 'prompt', 42, {
      agent: 'codex', schema: '/tmp/schema.json', mcp: true, model: 'model', probe: true,
      label: 'security lens', seed: 'small', key: 'DEV-63', repo: 'project', base: 'main', avoid: ['grok'],
      distinctModels: ['other-model'], retryOf: 7, cwd: '/tmp/repo', resume,
    })).toEqual({
      job: 'implement', prompt: 'prompt', reserveId: 42,
      agent: 'codex', schemaPath: '/tmp/schema.json', mcp: true, model: 'model', probe: true,
      label: 'security lens', seed: 'small', key: 'DEV-63', repo: 'project', base: 'main', avoid: ['grok'],
      distinctModels: ['other-model'], retryOf: 7, cwd: '/tmp/repo', resume,
    })
  })

  test('detach spawns exec.ts as its child entry point', () => {
    const cli = readFileSync(new URL('./cli.ts', import.meta.url).pathname, 'utf8')
    const detachSource = cli.slice(cli.indexOf('function detach('), cli.indexOf('function usage('))
    expect(detachSource).toContain("new URL('exec.ts', import.meta.url).pathname")
    expect(detachSource).not.toContain("new URL('cli.ts', import.meta.url).pathname")
  })

  test('detach with a bad execPath marks the reserved row failed/harness', () => {
    upsertProject({ name: 'spawn-fail', path: process.cwd() })
    const r = Bun.spawnSync([process.execPath, CLI, 'do', 'file-question', '--repo', 'spawn-fail', 'hello'], {
      env: {
        ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
        CLAUDE_CODE_SESSION_ID: 'orch-test-session',
        ORCH_EXEC_PATH: '/definitely/not-an-orch-exec-DEV-73',
      },
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(r.exitCode).not.toBe(0)
    const row = db().query(
      'SELECT agent, status, failure_kind, error, pid FROM run ORDER BY id DESC LIMIT 1',
    ).get() as { agent: string; status: string; failure_kind: string; error: string; pid: number | null }
    expect(row.agent).toBe('(pending)')
    expect(row.status).toBe('failed')
    expect(row.failure_kind).toBe('harness')
    expect(row.error).toContain('spawn failed')
    expect(row.error).toContain('/definitely/not-an-orch-exec-DEV-73')
    expect(row.pid).toBeNull()
  })

  test('a detached run has exactly one prompt file', () => {
    const binDir = join(dir, 'detach-bin')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'codex'), '#!/bin/sh\nprintf \'answer\'\n')
    chmodSync(join(binDir, 'codex'), 0o755)
    const p = Bun.spawnSync(
      [process.execPath, CLI, 'do', 'file-question', 'one prompt', '--agent', 'codex',
        '--label', 'security lens', '--detach'],
      { cwd: dir, stdout: 'pipe', stderr: 'pipe', env: {
        ...process.env, PATH: `${binDir}:${process.env.PATH}`, ORCH_DB: process.env.ORCH_DB!,
        ORCH_DEPTH: '0', CLAUDE_CODE_SESSION_ID: 'orch-test-session',
      } },
    )
    expect(p.exitCode).toBe(0)
    const id = Number(p.stdout.toString().trim().match(/\d+/)?.[0])
    expect(id).toBeGreaterThan(0)
    expect(p.stderr.toString()).toContain(
      `detached as run ${id}: orch wait ${id}, then orch result ${id}`,
    )
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const row = db().query('SELECT status FROM run WHERE id=?').get(id) as { status: string }
      if (row.status !== 'running') break
      Bun.sleepSync(20)
    }
    const recorded = db().query(
      'SELECT label, prompt_head, prompt_path FROM run WHERE id=?',
    ).get(id) as { label: string; prompt_head: string; prompt_path: string }
    expect({ label: recorded.label, prompt_head: recorded.prompt_head })
      .toEqual({ label: 'security lens', prompt_head: 'one prompt' })
    const listed = orch('runs', '--limit', '1')
    expect(listed.out).toContain('security lens')
    expect(listed.out).not.toContain('one prompt')
    const pending = orch('pending')
    expect(pending.out).toContain('security lens')
    expect(pending.out).not.toContain('one prompt')
    const runsDir = new URL('../runs', import.meta.url).pathname
    expect(recorded.prompt_path).toContain(`-${id}-`)
    expect(existsSync(recorded.prompt_path)).toBe(true)
    for (const name of readdirSync(runsDir).filter((name) => name.includes(`-${id}-`))) {
      rmSync(join(runsDir, name), { force: true })
    }
  })

  test('do help names every job and every supported flag', () => {
    for (const help of ['--help', '-h']) {
      const r = orch('do', help)
      expect(r.code).toBe(0)
      for (const name of Object.keys(JOBS)) expect(r.out).toContain(name)
      for (const name of [
        '--agent', '--schema', '--mcp', '--model', '--label', '--probe', '--seed', '--key',
        '--repo', '--base', '--avoid', '--distinct-from', '--file', '--detach', '--follow', '--quiet',
      ]) expect(r.out).toContain(name)
    }
  })

  test('a Codex schema rejected in preflight leaves no run row', () => {
    const schema = join(dir, 'unsupported-codex-schema.json')
    writeFileSync(schema, JSON.stringify({
      type: 'object', properties: {}, patternProperties: { '^x': { type: 'string' } },
    }))
    const before = (db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n
    const r = orch('do', 'file-question', 'answer this', '--agent', 'codex', '--schema', schema)
    expect(r.code).toBe(1)
    expect(r.err).toContain('$.patternProperties')
    expect((db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n).toBe(before)
  })

  test('runs --unscored uses the shared definition of an owed judgement', () => {
    const wanted = addRun({ agent: 'grok', job: 'craft' })
    addRun({ agent: 'grok', job: 'craft', probe: 1 })
    addRun({ agent: 'grok', job: 'craft', status: 'failed' })
    addRun({ agent: 'grok', job: 'craft', status: 'running' })
    const parent = addRun({ agent: 'grok', job: 'craft', status: 'failed' })
    addRun({ agent: 'grok', job: 'craft', parent, turn: 2 })

    const r = orch('runs', '--unscored', '--json')
    expect(r.code).toBe(0)
    expect(r.err).toBe('')
    const rows = r.out.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    expect(rows.map((row) => row.id)).toEqual([wanted])
  })

  test('pick previews the same fan-out exclusions do uses', () => {
    const prior = insert('ok', 'review-lens')
    db().query('UPDATE run SET agent=?, model=? WHERE id=?')
      .run('grok', AGENTS.grok!.model, prior)

    const avoided = orch('pick', 'review-lens', '--avoid', 'grok')
    expect(avoided.code).toBe(0)
    expect(avoided.out).toContain('review-lens -> codex')

    const distinct = orch('pick', 'review-lens', '--distinct-from', String(prior))
    expect(distinct.code).toBe(0)
    expect(distinct.out).toContain('review-lens -> codex')
  })

  test('pick shares do validation for fan-out exclusions', () => {
    const unknown = orch('pick', 'review-lens', '--avoid', 'nobody')
    expect(unknown.code).toBe(1)
    expect(unknown.err).toContain('unknown agent "nobody" in --avoid')

    const invalid = orch('pick', 'review-lens', '--distinct-from', 'not-a-run')
    expect(invalid.code).toBe(1)
    expect(invalid.err).toContain('--distinct-from expects comma-separated run ids')

    const contradictory = orch('pick', 'review-lens', '--agent', 'grok', '--avoid', 'grok')
    expect(contradictory.code).toBe(1)
    expect(contradictory.err).toContain('--agent grok contradicts --avoid grok')
  })

  test('pick reports the same unmet-constraint reason a run records', () => {
    const r = orch('pick', 'review-lens', '--avoid', 'grok,codex')
    expect(r.code).toBe(0)
    expect(r.out).toContain('exclusions could not be met, so routing proceeded normally')
  })

  test('jobs exposes fidelity only for writing jobs', () => {
    const r = orch('jobs')
    expect(r.code).toBe(0)
    const lines = r.out.trim().split('\n')
    expect(lines.find((line) => line.startsWith('implement'))).toContain('fidelity')
    expect(lines.find((line) => line.startsWith('fix'))).toContain('fidelity')
    expect(lines.find((line) => line.startsWith('review-lens'))).not.toContain('fidelity')
  })

  test('every score hint names the ROOT, never the turn it printed after', () => {
    /**
     * `orch result <turn>` printed `score it: orch score <turn>` — the one
     * command score refuses ("run 727 is one turn of run 725"). The first thing
     * the tool showed you was the thing it would not accept. scoreHint had been
     * right all along; two call sites simply did not use it.
     */
    const root = insert('ok', 'implement')
    const turn = insert('ok', 'implement')
    db().query('UPDATE run SET parent_run_id=?, turn=1 WHERE id=?').run(root, turn)
    const r = orch('result', String(turn))
    expect(r.err).toContain(`orch score ${root}`)
    expect(r.err).not.toContain(`orch score ${turn} <`)
    expect(r.err).toContain(`not turn ${turn}`)
  })

  test('a flag value is not mistaken for a run id', () => {
    // `--timeout 300` was read as a fourth run to wait for, and wait duly
    // reported "300 ok" for a run that has never existed.
    const id = insert('ok')
    const r = orch('wait', String(id), '--timeout', '300')
    expect(r.code).toBe(0)
    expect(r.out).toContain(`${id}\tok`)
    expect(r.out).not.toContain('300\t')
  })

  test('waiting on ok and asking runs succeeds and points to the inbox', () => {
    const ok = insert('ok')
    const asking = insert('asking', 'implement')
    const r = orch('wait', String(ok), String(asking))
    expect(r.code).toBe(0)
    expect(r.out).toContain(`${ok}\tok`)
    expect(r.out).toContain(`${asking}\tasking`)
    expect(r.out).toContain('orch inbox')
  })

  test('result on an asking run succeeds, prints its reply, and points to the inbox', () => {
    const id = insert('asking', 'implement')
    const output = join(dir, `asking-${id}.txt`)
    writeFileSync(output, 'I need a ruling.')
    db().query('UPDATE run SET output_path=? WHERE id=?').run(output, id)
    const r = orch('result', String(id))
    expect(r.code).toBe(0)
    expect(r.out).toContain('I need a ruling.')
    expect(r.err).toContain('orch inbox')
  })

  test('runs shows asking in the status column', () => {
    const id = insert('asking', 'implement')
    const r = orch('runs')
    expect(r.code).toBe(0)
    expect(r.out).toMatch(new RegExp(`\\b${id}\\s+codex\\s+implement\\s+asking\\b`))
  })

  test('waiting on a failed run exits non-zero', () => {
    const id = insert('failed')
    db().query(
      `UPDATE run SET error='worktree creation failed', failure_kind='harness', exit_code=17
        WHERE id=?`,
    ).run(id)
    const r = orch('wait', String(id))
    expect(r.code).toBe(1)
    expect(r.out).toContain(`${id}\tfailed\n  harness, exit 17: worktree creation failed`)
  })

  test('score refuses a harness-failed run even with force', () => {
    const id = insert('failed')
    db().query("UPDATE run SET failure_kind='harness' WHERE id=?").run(id)
    const r = orch('score', String(id), 'none', '--force')
    expect(r.code).toBe(1)
    expect(r.err).toContain(`run ${id}`)
    expect(r.err).toContain("failure kind 'harness' is not evidence")
    expect(db().query('SELECT * FROM score WHERE run_id=?').get(id)).toBeNull()
  })

  test("score refuses a run whose agent is '(pending)'", () => {
    const id = insert('failed')
    db().query("UPDATE run SET agent='(pending)' WHERE id=?").run(id)
    const r = orch('score', String(id), 'none')
    expect(r.code).toBe(1)
    expect(r.err).toContain(`run ${id}`)
    expect(r.err).toContain("agent is the placeholder '(pending)'")
    expect(db().query('SELECT * FROM score WHERE run_id=?').get(id)).toBeNull()
  })

  test('score drops a habitual fidelity word for a review lens and records two axes', () => {
    const id = insert('ok', 'review-lens')
    db().query('UPDATE run SET session_id=? WHERE id=?').run('orch-test-session', id)
    expect(orch('pending').code).toBe(1)

    const r = orch('score', String(id), 'full', 'right', 'faithful')
    expect(r.code).toBe(0)
    expect(r.err).toContain(
      'review-lens has no spec to be faithful to, so it is judged on two axes only',
    )
    expect(r.out).toContain(`scored full right  [1]`)
    expect(db().query(
      'SELECT delivery, quality, fidelity FROM score WHERE run_id=?',
    ).get(id)).toEqual({ delivery: 'full', quality: 'right', fidelity: null })
    expect(orch('pending').code).toBe(0)
  })

  test('doctor excludes scores on not-evidence runs from its scored count', () => {
    score(insert('ok'), 'full', 'right')
    const interrupted = insert('failed')
    db().query("UPDATE run SET failure_kind='interrupted' WHERE id=?").run(interrupted)
    score(interrupted, 'none')

    const r = orch('doctor')
    expect(r.code).toBe(0)
    expect(r.out).toContain('runs 2, scored 1, unscored 0')
  })

  test('doctor prints every CLI version and warns below its recorded minimum', () => {
    const binDir = join(dir, 'doctor-bin')
    mkdirSync(binDir, { recursive: true })
    const versions: Record<string, string> = {
      codex: 'codex-cli 0.150.0', grok: 'grok 1.0.13 (build)',
      agy: '1.1.24', qwen: '0.7.1',
    }
    for (const [bin, version] of Object.entries(versions)) {
      const path = join(binDir, bin)
      writeFileSync(path, `#!/bin/sh\necho '${version}'\n`)
      chmodSync(path, 0o755)
    }

    const p = Bun.spawnSync([process.execPath, CLI, 'doctor'], {
      env: {
        ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}`,
        ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0', ORCH_LOCAL_BASE_URL: '',
      },
      stdout: 'pipe', stderr: 'pipe',
    })
    const out = new TextDecoder().decode(p.stdout)
    expect(p.exitCode).toBe(0)
    for (const version of Object.values(versions)) expect(out).toContain(`version ${version}`)
    expect(out).toContain('WARNING: codex 0.150.0 is below minimum 0.151.0')
    expect(out).not.toContain('WARNING: grok')
    expect(out).not.toContain('WARNING: agy')
    expect(out).not.toContain('WARNING: qwen-local')
  })

  test('re-scoring keeps the old note and confirms every latest axis', () => {
    const id = insert('ok', 'implement')
    expect(orch('score', String(id), 'full', 'right', 'faithful', '--note', 'first reason').code)
      .toBe(0)
    const rescored = orch(
      'score', String(id), 'partial', 'mixed', 'partial', '--note', 'later reason',
    )
    expect(rescored.code).toBe(0)
    expect(rescored.out).toContain('scored partial mixed partial')
    const saved = db().query('SELECT note FROM score WHERE run_id=?').get(id) as { note: string }
    expect(saved.note).toContain('first reason')
    expect(saved.note).toContain('later reason')
    expect(saved.note).toMatch(/--- re-scored \d{4}-\d{2}-\d{2}T/)
  })

  test('required project flags are rejected before the prompt file is read', () => {
    upsertProject({
      name: 'needs-key', path: process.cwd(),
      settings: { worktree: { branch: 'feature/{key}-{id}' } },
    })
    const r = orch('do', 'implement', '--file', '/definitely/not/a/prompt')
    expect(r.code).toBe(1)
    expect(r.err).toContain('--key <KEY-123>')
    expect(r.err).not.toContain('ENOENT')
  })

  test('project set refuses incomplete resulting settings without saving them', () => {
    upsertProject({ name: 'warned', path: process.cwd() })
    const r = orch(
      'project', 'set', 'warned', '--settings',
      JSON.stringify({ worktree: { create: 'scripts/worktree create {branch} {seed}' } }),
    )
    expect(r.code).toBe(1)
    expect(r.err).toContain('has a create command but no branch template')
    expect(r.err).toContain('has a create command with a {seed} placeholder but no seeds list')
    const saved = db().query('SELECT settings FROM project WHERE name=?').get('warned') as
      { settings: string }
    expect(JSON.parse(saved.settings)).toEqual({})
  })

  test('project set --allow-incomplete saves and prints the same warnings', () => {
    upsertProject({ name: 'warned', path: process.cwd() })
    const r = orch(
      'project', 'set', 'warned', '--settings',
      JSON.stringify({ worktree: { create: 'scripts/worktree create {branch} {seed}' } }),
      '--allow-incomplete',
    )
    expect(r.code).toBe(0)
    expect(r.out).toContain('has a create command but no branch template')
    expect(r.out).toContain('has a create command with a {seed} placeholder but no seeds list')
    const saved = db().query('SELECT settings FROM project WHERE name=?').get('warned') as
      { settings: string }
    expect(JSON.parse(saved.settings)).toEqual({
      worktree: { create: 'scripts/worktree create {branch} {seed}' },
    })
  })

  test('project set settings null deletes that key during a deep merge', () => {
    upsertProject({ name: 'merged', path: process.cwd(), settings: { a: { b: 1, c: 2 } } })
    const r = orch('project', 'set', 'merged', '--settings', '{"a":{"b":null}}')
    expect(r.code).toBe(0)
    expect(projects().find((project) => project.name === 'merged')?.settings).toEqual({
      a: { c: 2 },
    })
  })

  test('project add and set --json print the resulting register row', () => {
    const added = orch(
      'project', 'add', dir, '--name', 'json-row', '--stack', 'first', '--no-canon', '--json',
    )
    expect(added.code).toBe(0)
    expect(JSON.parse(added.out)).toEqual(projects().find((project) => project.name === 'json-row'))

    const updated = orch('project', 'set', 'json-row', '--stack', 'second', '--canon', '--json')
    expect(updated.code).toBe(0)
    expect(JSON.parse(updated.out)).toEqual(projects().find((project) => project.name === 'json-row'))
  })

  test('an unattributed run warns with the explicit repo remedy', () => {
    const r = orch('do', 'summarize', '--file', '/definitely/not/a/prompt')
    expect(r.code).toBe(1)
    expect(r.err).toContain('will not be attributed to any project')
    expect(r.err).toContain('--repo <name>')
  })

  test('an explicit repo is validated before the prompt is read', () => {
    const r = orch(
      'do', 'summarize', '--repo', 'not-registered', '--file', '/definitely/not/a/prompt',
    )
    expect(r.code).toBe(1)
    expect(r.err).toContain('unknown repo "not-registered"')
    expect(r.err).not.toContain('ENOENT')
  })

  test('abandon retires an asking run and removes it from both inbox views', () => {
    const id = insert('asking', 'implement')
    db().query('UPDATE run SET session_id=? WHERE id=?').run('orch-test-session', id)
    db().query(
      `INSERT INTO question (run_id, asked_at, question)
       VALUES (?, ?, 'which design?')`,
    ).run(id, new Date().toISOString())
    expect(orch('inbox').out).toContain(`run ${id}`)
    expect(orch('inbox', '--all').out).toContain(`run ${id}`)

    const abandoned = orch('abandon', String(id), '--note', 'superseded')
    expect(abandoned.code).toBe(0)
    const run = db().query(
      'SELECT status, error, failure_kind FROM run WHERE id=?',
    ).get(id) as { status: string; error: string; failure_kind: string }
    expect(run).toEqual({
      status: 'stale', error: 'abandoned by architect: superseded', failure_kind: 'abandoned',
    })
    const question = db().query(
      'SELECT answer, answered_by, answered_at FROM question WHERE run_id=?',
    ).get(id) as { answer: string; answered_by: string; answered_at: string | null }
    expect(question.answer).toBe('(abandoned)')
    expect(question.answered_by).toBe('abandoned')
    expect(question.answered_at).not.toBeNull()
    expect(orch('inbox').out).not.toContain(`run ${id}`)
    expect(orch('inbox', '--all').out).not.toContain(`run ${id}`)
  })

  test('abandon refuses a completed run without changing it', () => {
    const id = insert('ok')
    const r = orch('abandon', String(id))
    expect(r.code).toBe(1)
    expect(r.err).toContain(`run ${id} is ok, not asking — nothing to abandon`)
    expect((db().query('SELECT status FROM run WHERE id=?').get(id) as { status: string }).status)
      .toBe('ok')
  })

  test('an abandoned run is not routing evidence', () => {
    const id = insert('asking', 'implement')
    expect(orch('abandon', String(id)).code).toBe(0)
    const c = candidates('implement').find((candidate) => candidate.agent === 'codex')!
    expect(c.evidence).toBe(0)
    expect(c.failures).toBe(0)
  })

  test('abandon does not delete a branch recorded by another run', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-abandon-'))
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    try {
      git('init', '-b', 'main')
      git('config', 'user.email', 'orch-test@example.invalid')
      git('config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, 'kept.txt'), 'base\n')
      git('add', 'kept.txt')
      git('commit', '-m', 'base')
      git('branch', 'shared-branch')

      const abandoned = insert('asking', 'implement')
      const owner = insert('stale', 'implement')
      const gone = join(repo, '.claude', 'worktrees', 'gone')
      db().query('UPDATE run SET cwd=?, worktree=?, branch=? WHERE id=?')
        .run(repo, gone, 'shared-branch', abandoned)
      db().query('UPDATE run SET branch=? WHERE id=?').run('shared-branch', owner)

      const r = orch('abandon', String(abandoned))
      expect(r.code).toBe(0)
      expect(r.out).toContain(`branch shared-branch left because run ${owner} records it`)
      expect(git('branch', '--list', 'shared-branch')).toContain('shared-branch')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('answer says an existing ruling stuck and reports the current status', () => {
    const id = insert('failed', 'implement')
    db().query(
      `INSERT INTO question (run_id, question, answer, asked_at, answered_at)
       VALUES (?, 'which way?', 'the ruled way', ?, ?)`,
    ).run(id, new Date().toISOString(), new Date().toISOString())
    const r = orch('answer', String(id), 'again')
    expect(r.code).toBe(1)
    expect(r.err).toContain('has already been ruled on')
    expect(r.err).toContain('current status is failed')
  })

  test('answer delivers a child turn live ruling without resuming the root', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    const child = addRun({
      agent: 'codex', job: 'implement', status: 'running', parent: root, turn: 2,
    })
    db().query('UPDATE run SET pid=? WHERE id=?').run(process.pid, child)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(child, new Date().toISOString(), 'which design?')
    const before = (db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n

    const r = orch('answer', String(root), 'use the first design')

    expect(r.code).toBe(0)
    expect(r.out).toContain('the owning turn is still working')
    expect((db().query('SELECT answer FROM question WHERE run_id=?').get(child) as
      { answer: string }).answer).toBe('use the first design')
    expect((db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n).toBe(before)
  })

  test('answer resumes a durable root question when no child is running', async () => {
    const root = addRun({ agent: 'missing-test-agent', job: 'implement', status: 'asking' })
    const prompt = join(dir, `answer-root-${root}.prompt.txt`)
    writeFileSync(prompt, 'original implementation spec')
    db().query('UPDATE run SET vendor_session=?, prompt_path=? WHERE id=?')
      .run('test-session', prompt, root)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(root, new Date().toISOString(), 'which design?')
    const before = (db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n

    const r = orch('answer', String(root), 'use the first design')

    expect(r.code).toBe(0)
    expect(r.out).toContain(`resumed run ${root} as run`)
    expect((db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n).toBe(before + 1)
    const resumed = db().query(
      'SELECT id FROM run WHERE id > ? ORDER BY id DESC LIMIT 1',
    ).get(root) as { id: number }

    for (let i = 0; i < 100; i++) {
      const status = (db().query('SELECT status FROM run WHERE id=?').get(resumed.id) as
        { status: string }).status
      if (status !== 'running') break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  })

  test('answer refuses questions split between live and stopped owners', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    const child = addRun({
      agent: 'codex', job: 'implement', status: 'running', parent: root, turn: 2,
    })
    db().query('UPDATE run SET pid=? WHERE id=?').run(process.pid, child)
    const insertQuestion = db().query(
      'INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)',
    )
    insertQuestion.run(root, new Date().toISOString(), 'root question?')
    insertQuestion.run(child, new Date().toISOString(), 'child question?')

    const r = orch('answer', String(root), 'one', 'two')

    expect(r.code).toBe(1)
    expect(r.err).toContain('both live and stopped turns')
    expect(r.err).toContain(`run ${child}, running`)
    expect(r.err).toContain(`run ${root}, asking`)
    expect((db().query(
      'SELECT COUNT(*) n FROM question WHERE answered_at IS NOT NULL',
    ).get() as { n: number }).n).toBe(0)
  })

  test('result on a still-running run exits 2, not 1', () => {
    // A poller must be able to tell "wait longer" from "stop waiting"; one exit
    // code for both would make a fan-out give up on its own runs.
    const id = insert('running')
    const r = orch('result', String(id))
    expect(r.code).toBe(2)
    expect(r.err).toContain('still running')
  })

  test('result on an unknown run says so rather than exiting 2', () => {
    expect(orch('result', '999999').code).toBe(1)
  })

  test('continue falls back to the chain\'s newest session when the latest turn has none', () => {
    const binDir = mkdtempSync(join(tmpdir(), 'orch-fake-codex-'))
    writeFileSync(join(binDir, 'codex'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(binDir, 'codex'), 0o755)
    const root = insert('ok', 'file-question')
    const prompt = join(dir, `continue-root-${root}.prompt.txt`)
    writeFileSync(prompt, 'original research spec')
    db().query('UPDATE run SET vendor_session=?, agent=?, prompt_path=? WHERE id=?')
      .run('parent-session', 'codex', prompt, root)
    const stale = insert('stale', 'file-question')
    db().query(
      'UPDATE run SET parent_run_id=?, turn=?, vendor_session=NULL, agent=? WHERE id=?',
    ).run(root, 2, 'codex', stale)
    try {
      const r = Bun.spawnSync(
        [process.execPath, CLI, 'continue', String(root)],
        {
          env: {
            ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
            CLAUDE_CODE_SESSION_ID: 'orch-test-session',
            PATH: `${binDir}:${process.env.PATH ?? ''}`,
          },
          stdout: 'pipe', stderr: 'pipe',
        },
      )
      const out = typeof r.stdout === 'string' ? r.stdout : new TextDecoder().decode(r.stdout)
      const err = typeof r.stderr === 'string' ? r.stderr : new TextDecoder().decode(r.stderr)
      expect(r.exitCode).toBe(0)
      expect(err).toContain(`newest turn ${stale} recorded no session id`)
      expect(err).toContain(`resuming with the session from run ${root} (turn 1)`)
      const childId = Number(out.replace(/\u001B\[[0-9;]*m/g, '').trim().split('\n')[0])
      expect(childId).toBeGreaterThan(0)
      orch('wait', String(childId), '--timeout', '15')
      const child = db().query(
        'SELECT status, parent_run_id, vendor_session FROM run WHERE id=?',
      ).get(childId) as
        { status: string; parent_run_id: number | null; vendor_session: string | null } | null
      expect(child?.status).not.toBe('running')
      expect(child?.parent_run_id).toBe(root)
      expect(child?.vendor_session).toBe('parent-session')
    } finally {
      rmSync(binDir, { recursive: true, force: true })
    }
  })
})

describe('vendor_session is recorded before the agent runs', () => {
  test('every resumed turn is prefixed with the root spec reminder without storing it again', async () => {
    const script = join(dir, 'resume-reminder.ts')
    writeFileSync(script, 'process.stdout.write("resumed")\n')
    const agent = AGENTS.codex!
    const origBin = agent.bin
    const origResume = agent.resumeArgv
    let sent = ''
    agent.bin = process.execPath
    agent.resumeArgv = ({ prompt }) => {
      sent = prompt
      return [script]
    }
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    const root = addRun({ agent: 'codex', job: 'file-question', status: 'ok' })
    const spec = 's'.repeat(600) + 'NOT INCLUDED'
    const rootPrompt = join(dir, 'root-spec.prompt.txt')
    writeFileSync(rootPrompt, spec)
    db().query('UPDATE run SET prompt_path=?, vendor_session=? WHERE id=?')
      .run(rootPrompt, 'test-session', root)
    try {
      const result = await runJob({
        job: 'file-question', prompt: 'the resumed-turn message', cwd: dir,
        resume: {
          parent: root, agent: 'codex', session: 'test-session', turn: 2,
          sessionId: 'orch-test-session', worktree: null,
        },
      })
      expect(sent).toBe([
        'REMINDER FROM THE ORIGINAL SPEC', '', 's'.repeat(600), '',
        'Do not decide what the spec did not settle; ask.',
        'Do not commit/push.', '', '---', '', 'the resumed-turn message',
      ].join('\n'))
      expect(readFileSync((db().query('SELECT prompt_path FROM run WHERE id=?').get(result.id) as
        { prompt_path: string }).prompt_path, 'utf8')).toBe('the resumed-turn message')
    } finally {
      agent.bin = origBin
      agent.resumeArgv = origResume
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(script, { force: true })
      rmSync(rootPrompt, { force: true })
    }
  })

  test('a resume claim stores the inherited session before the agent runs', async () => {
    const script = join(dir, 'read-own-session.ts')
    writeFileSync(script, `
import { Database } from 'bun:sqlite'
const row = new Database(process.env.ORCH_DB!).query(
  'SELECT vendor_session, status FROM run WHERE id = ?',
).get(Number(process.env.ORCH_RUN_ID))
process.stdout.write(JSON.stringify(row))
`)
    const agent = AGENTS.codex!
    const origBin = agent.bin
    const origResume = agent.resumeArgv
    agent.bin = process.execPath
    agent.resumeArgv = () => [script]
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    const inherited = 'inherited-session'
    const rootPrompt = join(dir, 'session-root.prompt.txt')
    writeFileSync(rootPrompt, 'original spec')
    const resume = (parent: number, turn: number) => ({
      parent, agent: 'codex', session: inherited, turn,
      sessionId: 'orch-test-session', worktree: null,
    })
    try {
      const parent = addRun({ agent: 'codex', job: 'file-question', status: 'stale' })
      db().query('UPDATE run SET vendor_session=?, prompt_path=? WHERE id=?')
        .run(inherited, rootPrompt, parent)

      const inserted = await runJob({
        job: 'file-question', prompt: 'continue', cwd: dir,
        resume: resume(parent, 2),
      })
      expect(JSON.parse(inserted.output)).toEqual({
        vendor_session: inherited, status: 'running',
      })

      const reserved = (db().query(
        `INSERT INTO run (started_at, agent, job, prompt_sha, prompt_bytes, prompt_head, status)
         VALUES (?, '(pending)', 'file-question', 'x', 1, 'x', 'running') RETURNING id`,
      ).get(new Date().toISOString()) as { id: number }).id
      const updated = await runJob({
        job: 'file-question', prompt: 'continue', cwd: dir, reserveId: reserved,
        resume: resume(parent, 3),
      })
      expect(updated.id).toBe(reserved)
      expect(JSON.parse(updated.output)).toEqual({
        vendor_session: inherited, status: 'running',
      })
    } finally {
      agent.bin = origBin
      agent.resumeArgv = origResume
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(rootPrompt, { force: true })
    }
  })
})

describe('childEnv allowlists the vendor CLI environment', () => {
  test('a spawned agent does not inherit unrelated credentials', async () => {
    const script = join(dir, 'dump-env-dev89.ts')
    writeFileSync(script, 'process.stdout.write(JSON.stringify(process.env))\n')
    const agent = AGENTS.codex!
    const origBin = agent.bin
    const origArgv = agent.argv
    agent.bin = process.execPath
    agent.argv = () => [script]
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'

    const planted = [
      'UNRELATED_SECRET_DEV89', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_SESSION_ID',
      'EXAMPLE_MCP_TOKEN', 'LC_ALL', 'XDG_CONFIG_HOME', 'OPENAI_API_KEY',
      'COLORTERM',
    ] as const
    const prior: Record<string, string | undefined> = {}
    for (const key of planted) prior[key] = process.env[key]
    process.env.UNRELATED_SECRET_DEV89 = 'should-not-leak'
    process.env.ANTHROPIC_API_KEY = 'should-not-leak'
    process.env.CLAUDE_CODE_SESSION_ID = 'should-not-leak'
    process.env.EXAMPLE_MCP_TOKEN = 'should-not-leak'
    process.env.LC_ALL = 'C'
    process.env.XDG_CONFIG_HOME = '/tmp/xdg-dev89'
    process.env.OPENAI_API_KEY = 'vendor-ok'
    process.env.COLORTERM = 'truecolor'
    upsertProject({ name: 'env-allow', path: dir, settings: { envPrefix: 'EXAMPLE' } })

    try {
      const result = await runJob({
        job: 'file-question', prompt: 'dump env', cwd: dir, agent: 'codex',
      })
      const child = JSON.parse(result.output) as Record<string, string>
      expect(child.UNRELATED_SECRET_DEV89).toBeUndefined()
      expect(child.ANTHROPIC_API_KEY).toBeUndefined()
      expect(child.CLAUDE_CODE_SESSION_ID).toBeUndefined()
      expect(child.EXAMPLE_MCP_TOKEN).toBeUndefined()
      expect(child.COLORTERM).toBeUndefined()
      expect(child.LC_ALL).toBe('C')
      expect(child.XDG_CONFIG_HOME).toBe('/tmp/xdg-dev89')
      expect(child.OPENAI_API_KEY).toBe('vendor-ok')
      expect(child.PATH).toBe(process.env.PATH as string)
      expect(child.HOME).toBe(process.env.HOME as string)
      expect(child.ORCH_DB).toBe(process.env.ORCH_DB as string)
      expect(child.ORCH_DEPTH).toBe('1')
      expect(child.ORCH_RUN_ID).toBe(String(result.id))
      expect(child.ORCH_RUN_TOKEN).toBeTruthy()
      for (const key of ['USER', 'SHELL', 'LANG', 'TERM', 'TMPDIR', 'SSH_AUTH_SOCK'] as const) {
        const parent = process.env[key]
        if (parent !== undefined) expect(child[key]).toBe(parent)
        else expect(child[key]).toBeUndefined()
      }
    } finally {
      agent.bin = origBin
      agent.argv = origArgv
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      for (const key of planted) {
        if (prior[key] === undefined) delete process.env[key]
        else process.env[key] = prior[key]
      }
    }
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

  test('a schema-shaped reply keeps its questions', () => {
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
})

describe('a writing worker must return evidence of completed work', () => {
  async function runInCleanTree(output: string): Promise<Awaited<ReturnType<typeof runJob>>> {
    const repo = mkdtempSync(join(tmpdir(), 'orch-empty-write-'))
    const script = join(dir, `worker-${Math.random().toString(16).slice(2)}.ts`)
    writeFileSync(join(repo, 'seed.txt'), 'seed\n')
    for (const args of [['init'], ['add', 'seed.txt']]) {
      const p = Bun.spawnSync(['git', ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    }
    const committed = Bun.spawnSync(['git', '-c', 'user.name=Orch Test',
      '-c', 'user.email=orch@example.invalid', 'commit', '-m', 'seed'], {
      cwd: repo, stdout: 'pipe', stderr: 'pipe',
    })
    if (committed.exitCode !== 0) throw new Error(committed.stderr.toString())
    const base = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: repo, stdout: 'pipe' })
      .stdout.toString().trim()
    writeFileSync(script, `process.stdout.write(${JSON.stringify(output)})\n`)

    const agent = AGENTS.codex!
    const origBin = agent.bin
    const origResume = agent.resumeArgv
    const origReadsOut = agent.readsOut
    agent.bin = process.execPath
    agent.resumeArgv = () => [script]
    agent.readsOut = false
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    const parent = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    const rootPrompt = join(dir, `write-root-${parent}.prompt.txt`)
    writeFileSync(rootPrompt, 'original implementation spec')
    db().query('UPDATE run SET prompt_path=? WHERE id=?').run(rootPrompt, parent)
    try {
      return await runJob({
        job: 'implement', prompt: 'continue', cwd: repo,
        resume: {
          parent, agent: 'codex', session: 'test-session', turn: 2,
          sessionId: 'orch-test-session',
          worktree: { path: repo, branch: 'DEV-76', base, repoRoot: repo },
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
    const row = db().query('SELECT status, error, files_changed FROM run WHERE id=?')
      .get(failure!.runId!) as { status: string; error: string; files_changed: number }
    expect(row).toEqual({
      status: 'failed', error: 'reported done with no change and no test run', files_changed: 0,
    })
  })

  test('multiple contracts leave a visible note on an otherwise successful run', async () => {
    const result = await runInCleanTree([
      workerReply({ summary: 'real reply' }),
      workerReply({ summary: 'quoted contract-shaped object' }),
    ].map((value) => JSON.stringify(value)).join('\n'))
    expect(result.contract?.summary).toBe('quoted contract-shaped object')
    expect((db().query('SELECT error FROM run WHERE id=?').get(result.id) as { error: string }).error)
      .toBe('2 contract objects in output; took the last')
  })
})

describe('a conversation is one unit of work, not one per turn', () => {
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

describe('a worktree is resolved against the main checkout, not the caller cwd', () => {
  const fromRoot = (fn: () => void) => {
    const priorDepth = process.env.ORCH_DEPTH
    try {
      process.env.ORCH_DEPTH = '0'
      fn()
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  }

  /**
   * The bug shipped because every test called git from the main checkout.
   * `--show-toplevel` is correct THERE and wrong from inside a worktree, which
   * is exactly where one session ran orch and lost a day. The test
   * therefore cds into a real nested worktree.
   */
  const git = (cwd: string, ...args: string[]) => {
    const p = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
    if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    return p.stdout.toString().trim()
  }

  function scratchRepo(): { repo: string; tree: string } {
    const repo = mkdtempSync(join(tmpdir(), 'orch-nested-'))
    git(repo, 'init', '-b', 'main')
    git(repo, 'config', 'user.email', 'orch-test@example.invalid')
    git(repo, 'config', 'user.name', 'Orch Test')
    writeFileSync(join(repo, 'kept.txt'), 'base\n')
    git(repo, 'add', 'kept.txt')
    git(repo, 'commit', '-m', 'base')
    const tree = join(repo, '.claude', 'worktrees', 'AB-2581')
    mkdirSync(join(repo, '.claude', 'worktrees'), { recursive: true })
    git(repo, 'worktree', 'add', '-b', 'AB-2581', tree, 'main')
    return { repo, tree }
  }

  test('review-lens preflight requires a git checkout', () => {
    const outside = mkdtempSync(join(tmpdir(), 'orch-no-repo-'))
    const { repo } = scratchRepo()
    const priorDepth = process.env.ORCH_DEPTH
    try {
      process.env.ORCH_DEPTH = '0'
      expect(() => preflight('review-lens', outside)).toThrow('not inside a git checkout')
      expect(() => preflight('review-lens', repo)).not.toThrow()
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(outside, { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('preflight refuses a create command without a branch template', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-no-branch-'))
    upsertProject({
      name: 'no-branch', path: repo,
      settings: { worktree: { create: 'scripts/worktree create {branch}' } },
    })
    expect(() => fromRoot(() => preflight('implement', repo))).toThrow(
      'orch project set no-branch --settings \'{"worktree":{"branch":"<template>"}}\'',
    )
    rmSync(repo, { recursive: true, force: true })
  })

  test('preflight refuses shell metacharacters in a key', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-bad-key-'))
    upsertProject({
      name: 'bad-key', path: repo,
      settings: { worktree: { recipe: {}, branch: '{key}-orch-{id}' } },
    })
    expect(() => fromRoot(() => preflight('implement', repo, undefined, 'DEV-70; touch nope')))
      .toThrow('key "DEV-70; touch nope" does not match ^[A-Z][A-Z0-9]+-[0-9]+$')
    rmSync(repo, { recursive: true, force: true })
  })

  test('preflight reports missing key and seed together', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-missing-arguments-'))
    upsertProject({
      name: 'missing-arguments', path: repo,
      settings: {
        worktree: {
          create: 'scripts/worktree create {branch} {seed}', branch: '{key}-orch-{id}',
          seeds: ['small', 'full'],
        },
      },
    })
    expect(() => fromRoot(() => preflight('implement', repo))).toThrow(
      `this project's branch names must carry a ticket key ({key}-orch-{id}), and orch will ` +
      `not invent one.\n  --key <KEY-123>\n` +
      `this project requires a database size for a new worktree, and has no default.\n` +
      `  --seed small\n  --seed full\n\n` +
      `Choosing is the architect's call: it depends on what the task touches.`,
    )
    expect(() => fromRoot(() => preflight('implement', repo, 'small'))).toThrow(
      `this project's branch names must carry a ticket key ({key}-orch-{id}), and orch will ` +
      `not invent one.\n  --key <KEY-123>`,
    )
    expect(() => fromRoot(() => preflight('implement', repo, undefined, 'DEV-61'))).toThrow(
      `this project requires a database size for a new worktree, and has no default.\n` +
      `  --seed small\n  --seed full\n\n` +
      `Choosing is the architect's call: it depends on what the task touches.`,
    )
    rmSync(repo, { recursive: true, force: true })
  })

  test('fill shell-quotes unquoted values and respects existing quotes', () => {
    const value = "two words' ; echo nope"
    for (const render of [fill, fillTool]) {
      expect(render('cmd {name}', { name: value })).toBe("cmd 'two words'\\'' ; echo nope'")
      expect(render("cmd '{name}'", { name: value })).toBe("cmd 'two words'\\'' ; echo nope'")
      expect(render('cmd "{name}"', { name: value })).toBe("cmd \"two words' ; echo nope\"")
    }
  })

  test('registered create templates render safely for plain values', () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-render-templates-'))
    const fixtures = [
      { name: 'array-tool', create: 'echo \'{"cwd":"\'"$PWD"\'","name":"{name}"}\' | bun run scripts/worktree.ts create' },
      { name: 'positional-tool', create: "scripts/worktree add {branch} '' {seed} --name={name} && echo $PWD/.claude/worktrees/{name}" },
      { name: 'registered-only' },
      { name: 'environment-tool', create: "WORKTREE_NAME_OVERRIDE={name} WORKTREE_SEED={seed} scripts/worktree add {branch}" },
      { name: 'quoted-tool', create: 'bun run worktree create "{branch}"' },
    ]
    for (const fixture of fixtures) {
      upsertProject({
        name: fixture.name,
        path: join(root, fixture.name),
        settings: fixture.create ? { worktree: { create: fixture.create } } : {},
      })
    }
    const vars = {
      branch: 'technical/DEV-70-orch-804', seed: 'none', name: 'orch-804',
      path: '/tmp/orch-804', base: 'main', key: 'DEV-70',
    }
    const rendered = projects().map((project) => ({
      name: project.name,
      create: project.settings.worktree?.create
        ? fillTool(project.settings.worktree.create, vars)
        : null,
    }))
    try {
      expect(rendered).toEqual([
      {
        name: 'array-tool',
        create: 'echo \'{"cwd":"\'"$PWD"\'","name":"orch-804"}\' | bun run scripts/worktree.ts create',
      },
      {
        name: 'environment-tool',
        create: "WORKTREE_NAME_OVERRIDE='orch-804' WORKTREE_SEED='none' scripts/worktree add 'technical/DEV-70-orch-804'",
      },
      {
        name: 'positional-tool',
        create: "scripts/worktree add 'technical/DEV-70-orch-804' '' 'none' --name='orch-804' && echo $PWD/.claude/worktrees/'orch-804'",
      },
      { name: 'quoted-tool', create: 'bun run worktree create "technical/DEV-70-orch-804"' },
      { name: 'registered-only', create: null },
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('preflight refuses a create placeholder without --seed even when no seeds are listed', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-no-seed-'))
    upsertProject({
      name: 'no-seed', path: repo,
      settings: { worktree: { create: 'scripts/worktree create {seed}', branch: 'task/{id}' } },
    })
    expect(() => fromRoot(() => preflight('implement', repo))).toThrow(
      'contains {seed}, so a seed is required',
    )
    rmSync(repo, { recursive: true, force: true })
  })

  test('preflight refuses a seed outside the listed choices', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-bad-seed-'))
    upsertProject({
      name: 'bad-seed', path: repo,
      settings: {
        worktree: {
          create: 'scripts/worktree create {seed}', branch: 'task/{id}', seeds: ['small', 'full'],
        },
      },
    })
    expect(() => fromRoot(() => preflight('implement', repo, 'medium'))).toThrow(
      'unknown seed "medium"; this project lists:\n  --seed small\n  --seed full',
    )
    rmSync(repo, { recursive: true, force: true })
  })

  test('preflight accepts a branch template and a listed seed', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-good-tool-'))
    upsertProject({
      name: 'good-tool', path: repo,
      settings: {
        worktree: {
          create: 'scripts/worktree create {branch} {seed}', branch: 'task/{id}',
          seeds: ['small', 'full'],
        },
      },
    })
    expect(() => fromRoot(() => preflight('implement', repo, 'small'))).not.toThrow()
    rmSync(repo, { recursive: true, force: true })
  })

  test('from inside a worktree, repoRootOf is the main checkout, not this tree', () => {
    const { repo, tree } = scratchRepo()
    const here = process.cwd()
    try {
      process.chdir(tree)
      const got = repoRootOf(process.cwd())
      expect(got).not.toBeNull()
      expect(realpathSync(got!)).toBe(realpathSync(repo))
      expect(realpathSync(got!)).not.toBe(realpathSync(tree))
      // And the naive --show-toplevel answer, which is what shipped, is the
      // worktree itself. If this ever stops being true the bug cannot recur
      // in the same shape and the test should be rewritten, not weakened.
      const toplevel = git(process.cwd(), 'rev-parse', '--show-toplevel')
      expect(realpathSync(toplevel)).toBe(realpathSync(tree))
    } finally {
      process.chdir(here)
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('createWorktree from inside a worktree does not nest under it', () => {
    const { repo, tree } = scratchRepo()
    const here = process.cwd()
    try {
      process.chdir(tree)
      const w = createWorktree(process.cwd(), 657)
      expect(realpathSync(w.repoRoot)).toBe(realpathSync(repo))
      expect(realpathSync(w.path)).toBe(
        realpathSync(join(repo, '.claude', 'worktrees', 'orch-657')),
      )
      expect(w.path.startsWith(tree)).toBe(false)
      expect(existsSync(join(tree, '.claude', 'worktrees', 'orch-657'))).toBe(false)
      expect(readFileSync(join(w.path, '.orch-run'), 'utf8')).toBe(`657\n${realpathSync(repo)}\n`)
      const exclude = resolve(w.path, git(w.path, 'rev-parse', '--git-path', 'info/exclude'))
      expect(readFileSync(exclude, 'utf8').split('\n')).toContain('.orch-run')
      expect(git(w.path, 'check-ignore', '.orch-run')).toBe('.orch-run')
    } finally {
      process.chdir(here)
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('the path is read from stdout, whatever the tool says on stderr afterwards', () => {
    // One project's shape: path on stdout, progress on stderr, and the progress
    // printed last. Joining the streams put a progress line where the path
    // should be and sent run 735 to a directory nothing had created.
    const { repo, tree } = scratchRepo()
    const here = process.cwd()
    const custom = join(repo, 'elsewhere', 'technical_sto_993_orch_735')
    try {
      process.chdir(tree)
      const w = createWithTool(
        {
          create:
            `mkdir -p "${custom}" && echo "${custom}" && ` +
            `echo 'Database cloned.' >&2 && echo 'task status not written' >&2`,
        },
        process.cwd(),
        735,
      )
      expect(w.path).toBe(custom)
    } finally {
      process.chdir(here)
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a tool that prints its path is believed, not second-guessed', () => {
    const { repo, tree } = scratchRepo()
    const here = process.cwd()
    const custom = join(repo, 'elsewhere', 'custom-657')
    try {
      process.chdir(tree)
      const w = createWithTool(
        { create: `mkdir -p "${custom}" && echo "${custom}"` },
        process.cwd(),
        657,
      )
      expect(w.path).toBe(custom)
      expect(existsSync(join(repo, '.claude', 'worktrees', 'orch-657'))).toBe(false)
    } finally {
      process.chdir(here)
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a successful tool postcondition failure names its branch and remove command', () => {
    const { repo, tree } = scratchRepo()
    const here = process.cwd()
    try {
      process.chdir(tree)
      expect(() => createWithTool(
        {
          branch: 'technical/{key}-orch-{id}',
          create: `echo "${join(repo, 'missing-tree')}"`,
          remove: 'scripts/worktree remove {branch}',
        },
        process.cwd(), 735, undefined, 'STO-993',
      )).toThrow("scripts/worktree remove 'technical/STO-993-orch-735'")
    } finally {
      process.chdir(here)
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('an explicit base reaches a tool whose template asks for it', () => {
    const { repo, tree } = scratchRepo()
    const here = process.cwd()
    const custom = join(repo, 'elsewhere', 'based-746')
    try {
      process.chdir(tree)
      const expected = resolveBase(process.cwd(), 'main')
      const w = createWithTool(
        {
          create: `git worktree add -b {branch} "${custom}" {base} >/dev/null && echo "${custom}"`,
          remove: 'git worktree remove {path}',
        },
        process.cwd(), 746, undefined, undefined, 'main',
      )
      expect(w.base).toBe(expected)
      expect(git(custom, 'rev-parse', 'HEAD')).toBe(expected)
    } finally {
      process.chdir(here)
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('discard uses a registered project remove template', () => {
    const { repo } = scratchRepo()
    const tree = createWorktree(repo, 880)
    const argvFile = join(repo, 'remove-argv.txt')
    const script = join(repo, 'fake-remove.sh')
    writeFileSync(script,
      `printf '%s\n' "$@" > "${argvFile}"\n` +
      'git worktree remove --force "$1"\n' +
      'git branch -D "$2"\n')
    upsertProject({
      name: 'remove-tool', path: realpathSync(repo),
      settings: { worktree: { remove: `sh "${script}" {path} {branch}` } },
    })
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET worktree=?, branch=? WHERE id=?')
      .run(tree.path, tree.branch, id)
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'discard', String(id)], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(readFileSync(argvFile, 'utf8').trim().split('\n')).toEqual([
        tree.path, tree.branch,
      ])
      expect(existsSync(tree.path)).toBe(false)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('discard surfaces a registered project remove refusal', () => {
    const { repo } = scratchRepo()
    const tree = createWorktree(repo, 881)
    upsertProject({
      name: 'refusing-tool', path: realpathSync(repo),
      settings: { worktree: { remove: "echo 'protected work' >&2; exit 7" } },
    })
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET worktree=?, branch=? WHERE id=?')
      .run(tree.path, tree.branch, id)
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'discard', String(id)], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).not.toBe(0)
      expect(p.stderr.toString()).toContain('protected work')
      expect(existsSync(tree.path)).toBe(true)
      const row = db().query('SELECT worktree FROM run WHERE id=?').get(id) as
        { worktree: string | null }
      expect(row.worktree).toBe(tree.path)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('discard on an unregistered repository uses git removal', () => {
    const { repo } = scratchRepo()
    const tree = createWorktree(repo, 882)
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET worktree=?, branch=? WHERE id=?')
      .run(tree.path, tree.branch, id)
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'discard', String(id)], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(existsSync(tree.path)).toBe(false)
      expect(git(repo, 'branch', '--list', tree.branch)).toBe('')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('discard keeps a branch with an unmerged commit and records it', () => {
    const { repo } = scratchRepo()
    const tree = createWorktree(repo, 883)
    writeFileSync(join(tree.path, 'architect.txt'), 'work in progress\n')
    git(tree.path, 'add', 'architect.txt')
    git(tree.path, 'commit', '-m', 'architect work')
    const tip = git(tree.path, 'rev-parse', 'HEAD')
    const script = join(repo, 'remove-and-delete.sh')
    writeFileSync(script,
      'git worktree remove --force "$1"\n' +
      'git branch -D "$2"\n')
    upsertProject({
      name: 'protected-tool', path: realpathSync(repo),
      settings: { worktree: { remove: `sh "${script}" {path} {branch}` } },
    })
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET repo=?, cwd=?, worktree=?, branch=? WHERE id=?')
      .run('protected-tool', repo, tree.path, tree.branch, id)
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'discard', String(id)], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(p.stdout.toString()).toContain(
        `kept branch ${tree.branch}: 1 commit(s) not on main — merge it, or ` +
        `orch discard ${id} --force to delete it`,
      )
      expect(existsSync(tree.path)).toBe(false)
      expect(git(repo, 'rev-parse', tree.branch)).toBe(tip)
      expect(db().query('SELECT branch_kept FROM run WHERE id=?').get(id))
        .toEqual({ branch_kept: tree.branch })

      const forced = Bun.spawnSync(
        [process.execPath, CLI, 'discard', String(id), '--force'],
        {
          env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
          stdout: 'pipe', stderr: 'pipe',
        },
      )
      expect(forced.exitCode).toBe(0)
      expect(git(repo, 'branch', '--list', tree.branch)).toBe('')
      expect(db().query('SELECT branch_kept FROM run WHERE id=?').get(id))
        .toEqual({ branch_kept: null })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('discard --force deletes a branch with an unmerged commit', () => {
    const { repo } = scratchRepo()
    const tree = createWorktree(repo, 884)
    writeFileSync(join(tree.path, 'architect.txt'), 'work in progress\n')
    git(tree.path, 'add', 'architect.txt')
    git(tree.path, 'commit', '-m', 'architect work')
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, id)
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'discard', String(id), '--force'], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(git(repo, 'branch', '--list', tree.branch)).toBe('')
      expect(db().query('SELECT branch_kept FROM run WHERE id=?').get(id))
        .toEqual({ branch_kept: null })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('discard deletes a branch whose commit is merged into trunk', () => {
    const { repo } = scratchRepo()
    const tree = createWorktree(repo, 885)
    writeFileSync(join(tree.path, 'merged.txt'), 'merged work\n')
    git(tree.path, 'add', 'merged.txt')
    git(tree.path, 'commit', '-m', 'merged work')
    git(repo, 'merge', '--ff-only', tree.branch)
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, id)
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'discard', String(id)], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(git(repo, 'branch', '--list', tree.branch)).toBe('')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('abandon keeps a branch with an unmerged commit', () => {
    const { repo } = scratchRepo()
    const tree = createWorktree(repo, 886)
    writeFileSync(join(tree.path, 'architect.txt'), 'work in progress\n')
    git(tree.path, 'add', 'architect.txt')
    git(tree.path, 'commit', '-m', 'architect work')
    const id = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, id)
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'abandon', String(id)], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(p.stdout.toString()).toContain(
        `kept branch ${tree.branch}: 1 commit(s) not on main — merge it, or ` +
        `orch discard ${id} --force to delete it`,
      )
      expect(git(repo, 'branch', '--list', tree.branch)).toContain(tree.branch)
      expect(db().query('SELECT branch_kept FROM run WHERE id=?').get(id))
        .toEqual({ branch_kept: tree.branch })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('recipe failure runs its declared stop before removing the tree', () => {
    const { repo } = scratchRepo()
    const stopped = join(repo, 'recipe-stopped.txt')
    const tool = {
      recipe: {
        serve: 'serve --port {port}',
        stop: `printf stopped > "${stopped}"`,
        after: 'exit 9',
      },
    }
    upsertProject({
      name: 'recipe-project', path: realpathSync(repo), settings: { worktree: tool },
    })
    try {
      expect(() => createWithTool(tool, repo, 883)).toThrow('worktree setup failed at "after"')
      expect(readFileSync(stopped, 'utf8')).toBe('stopped')
      expect(existsSync(join(repo, '.claude', 'worktrees', 'orch-883'))).toBe(false)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
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
      await run({ job: 'file-question', prompt: 'hello', agent: 'grok', reserveId: reserved })
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

describe('fan-out routing exclusions', () => {
  test('avoid removes an agent while another eligible agent remains', () => {
    expect(pick('review-lens', undefined, 0, false, null, false,
      { agents: ['grok'] }).agent).toBe('codex')
  })

  test('exhausted exclusions degrade visibly instead of refusing', () => {
    const p = pick('review-lens', undefined, 0, false, null, false,
      { agents: ['grok', 'codex'] })
    expect(['grok', 'codex']).toContain(p.agent)
    expect(p.reason).toContain('exclusions could not be met')
  })

  test('degraded MCP routing names agents excluded by sandbox safety', () => {
    const p = pick('mcp-query', undefined, 0, false, null, true,
      { agents: ['grok'] })
    expect(p.agent).toBe('grok')
    expect(p.reason).toContain('exclusions could not be met, so routing proceeded normally')
    expect(p.reason).toContain(
      'excluded agents: codex: cannot make MCP tool calls without a writable sandbox',
    )
    for (const c of candidates('mcp-query').filter((candidate) => !candidate.eligible)) {
      expect(p.reason).toContain(`${c.agent}: ${c.why}`)
    }
  })

  test('an explicit pin that is also avoided is refused', () => {
    expect(() => pick('review-lens', 'grok', 0, false, null, false,
      { agents: ['grok'] })).toThrow('contradicts')
  })

  test('distinct models exclude the agent currently using one', () => {
    expect(pick('review-lens', undefined, 0, false, null, false,
      { models: [AGENTS.grok!.model] }).agent).toBe('codex')
  })
})

describe('orphan worktrees keep anything unique', () => {
  const git = (cwd: string, ...args: string[]) => {
    const p = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
    if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    return p.stdout.toString().trim()
  }

  test('only a clean worktree fully reachable from main is removable', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-orphan-'))
    const tree = join(repo, '.claude', 'worktrees', 'orphan')
    try {
      git(repo, 'init', '-b', 'main')
      git(repo, 'config', 'user.email', 'orch-test@example.invalid')
      git(repo, 'config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, 'kept.txt'), 'base\n')
      git(repo, 'add', 'kept.txt')
      git(repo, 'commit', '-m', 'base')
      git(repo, 'worktree', 'add', '-b', 'orphan', tree, 'main')

      expect(orphanSafety(tree, repo, 'main')).toMatchObject({ removable: true })
      writeFileSync(join(tree, 'new.txt'), 'unique\n')
      expect(orphanSafety(tree, repo, 'main')).toMatchObject({
        removable: false, detail: 'has uncommitted changes',
      })
      git(tree, 'add', 'new.txt')
      git(tree, 'commit', '-m', 'unique')
      expect(orphanSafety(tree, repo, 'main')).toMatchObject({
        removable: false, detail: 'has commits not reachable from main',
      })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('sweep only reclaims old orch-owned orphan worktrees', () => {
  const CLI = new URL('cli.ts', import.meta.url).pathname
  const orch = (...args: string[]) => {
    const p = Bun.spawnSync([process.execPath, CLI, ...args], {
      env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
      stdout: 'pipe', stderr: 'pipe',
    })
    return {
      code: p.exitCode,
      out: new TextDecoder().decode(p.stdout),
      err: new TextDecoder().decode(p.stderr),
    }
  }
  const git = (cwd: string, ...args: string[]) => {
    const p = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
    if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    return p.stdout.toString().trim()
  }
  const scratchRepo = () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-sweep-'))
    git(repo, 'init', '-b', 'main')
    git(repo, 'config', 'user.email', 'orch-test@example.invalid')
    git(repo, 'config', 'user.name', 'Orch Test')
    writeFileSync(join(repo, 'kept.txt'), 'base\n')
    git(repo, 'add', 'kept.txt')
    git(repo, 'commit', '-m', 'base')
    mkdirSync(join(repo, '.claude', 'worktrees'), { recursive: true })
    upsertProject({ name: `sweep-${repo.split('/').pop()}`, path: repo })
    return repo
  }

  test('invalid older-than values refuse before sweeping', () => {
    for (const value of ['typo', '-1']) {
      const r = orch('sweep', '--older-than', value)
      expect(r.code).not.toBe(0)
      expect(r.err).toContain('--older-than must be a finite, non-negative number')
    }
  })

  test('an unrecognised orphan is kept even with force', () => {
    const repo = scratchRepo()
    const tree = join(repo, '.claude', 'worktrees', 'reader')
    try {
      git(repo, 'worktree', 'add', '-b', 'reader', tree, 'main')
      const r = orch('sweep', '--older-than', '0', '--force')
      expect(r.code).toBe(0)
      expect(r.out).toContain(`orphan  ${tree}  kept: not created by orch`)
      expect(existsSync(tree)).toBe(true)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a young orch-named orphan is kept until the threshold', () => {
    const repo = scratchRepo()
    const tree = join(repo, '.claude', 'worktrees', 'orch-900')
    try {
      git(repo, 'worktree', 'add', '-b', 'orch/900', tree, 'main')
      const r = orch('sweep', '--older-than', '1')
      expect(r.code).toBe(0)
      expect(r.out).toContain(`orphan  ${tree}  too recent (0.0d)`)
      expect(existsSync(tree)).toBe(true)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('an old marked orphan is reclaimed', () => {
    const repo = scratchRepo()
    const tree = join(repo, '.claude', 'worktrees', 'old-worker')
    try {
      git(repo, 'worktree', 'add', '-b', 'old-worker', tree, 'main')
      writeFileSync(join(tree, '.orch-run'), `901\n${repo}\n`)
      appendFileSync(resolve(tree, git(tree, 'rev-parse', '--git-path', 'info/exclude')), '.orch-run\n')
      const old = new Date(Date.now() - 2 * 86_400_000)
      utimesSync(join(tree, '.orch-run'), old, old)

      const r = orch('sweep', '--older-than', '1')
      expect(r.code).toBe(0)
      expect(r.out).toContain(`reclaimed orphan  ${tree}`)
      expect(existsSync(tree)).toBe(false)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('only an agent that can be resumed may be asked to escalate', () => {
  test('implement requires writing AND resumability', () => {
    // Both are load-bearing: an agent that cannot write cannot do the job, and
    // one that cannot be resumed would have to restart to hear an answer, which
    // makes asking cost more than guessing.
    const j = JOBS.implement!
    expect(j.needs.writesRepo).toBe(true)
    expect(j.needs.resumable).toBe(true)
  })

  test('every agent claiming resumable can actually be resumed', () => {
    // The invariant agents.ts enforces at import, asserted here so the reason
    // is written down where it is checked: a flag in a help text is not a
    // capability if orch has no id to resume with.
    for (const a of Object.values(AGENTS)) {
      if (!a.caps.resumable) continue
      expect(a.resumeArgv).toBeDefined()
      expect(a.mintSession ?? a.readSession).toBeDefined()
    }
  })

  test('grok is eligible for writing jobs after its write round-trip', () => {
    expect(AGENTS.grok!.caps.writesRepo).toBe(true)
    expect(AGENTS.grok!.caps.resumable).toBe(true)
    for (const job of ['implement', 'fix']) {
      expect(candidates(job).map((c) => c.agent)).toContain('grok')
    }
  })

  test('grok bypasses permission prompts for reading and writing jobs', () => {
    const grok = AGENTS.grok!
    for (const write of [false, true]) {
      const args = grok.argv({ prompt: 'p', out: '/tmp/o', write })
      expect(args).toContain('--permission-mode')
      expect(args[args.indexOf('--permission-mode') + 1]).toBe('bypassPermissions')
      expect(args).not.toContain('acceptEdits')
    }
  })

  test('a writing agent gets a writable sandbox and a reading one does not', () => {
    const codex = AGENTS.codex!
    expect(codex.argv({ prompt: 'p', out: '/tmp/o', write: true })).toContain('workspace-write')
    expect(codex.argv({ prompt: 'p', out: '/tmp/o' })).toContain('read-only')
  })

  test('codex resume puts its flags BEFORE the subcommand', () => {
    // `codex exec resume <id> -s read-only` is rejected outright: parsing stops
    // at the subcommand. The order reads backwards and is easy to "tidy".
    const a = AGENTS.codex!.resumeArgv!({ prompt: 'ruling', out: '/tmp/o', session: 'abc' })
    expect(a.indexOf('resume')).toBeGreaterThan(a.indexOf('--json'))
    expect(a[a.indexOf('resume') + 1]).toBe('abc')
  })
})

describe('grok reply parsing', () => {
  test('takes only the terminal result from a tool-using message stream', () => {
    const stdout = [
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: "I'll fetch it first." }], stop_reason: 'tool_use' },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: '## Finding' }], stop_reason: 'end_turn' },
      }),
      JSON.stringify({
        type: 'result', subtype: 'success', result: '## Finding', total_cost_usd: 0.25,
        usage: { input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 5 },
      }),
    ].join('\n')
    expect(AGENTS.grok!.parseReply!(stdout)).toEqual({
      text: '## Finding', tokens: 35, costUsd: 0.25,
    })
  })

  test('uses the clean stream for plain and schema-constrained replies', () => {
    const out = join(dir, 'grok-out.txt')
    expect(AGENTS.grok!.argv({ prompt: 'x', out, model: 'grok-4.6' }))
      .toContain('streaming-messages-json')
    const schema = join(dir, 'grok-schema.json')
    writeFileSync(schema, '{}')
    const args = AGENTS.grok!.argv({ prompt: 'x', out, model: 'grok-4.6', schema })
    expect(args).toContain('streaming-messages-json')
    expect(args.indexOf('--json-schema')).toBeLessThan(args.indexOf('--output-format'))
  })

  test('records a cancelled result event as a failed run with its error', async () => {
    const stdout = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'trimmed' }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Working.' }], stop_reason: 'tool_use' },
      }),
      JSON.stringify({
        type: 'result', subtype: 'error_during_execution', errors: ['cancelled'],
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
    ].join('\n')
    const script = join(dir, 'fake-grok-cancelled.sh')
    writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' '${stdout}'\n`)
    chmodSync(script, 0o755)
    const grok = AGENTS.grok!
    const previous = grok.bin
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      grok.bin = script
      const reserved = addRun({ agent: '(pending)', job: 'file-question', status: 'running' })
      await expect(run({ job: 'file-question', prompt: 'hello', agent: 'grok', reserveId: reserved }))
        .rejects.toThrow('cancelled')
      const failed = db().query(
        'SELECT status, failure_kind, error, output_path, output_bytes FROM run WHERE id=?',
      ).get(reserved) as {
        status: string; failure_kind: string; error: string
        output_path: string; output_bytes: number
      }
      expect(failed.status).toBe('failed')
      expect(failed.failure_kind).toBe('other')
      expect(failed.error).toBe('cancelled')
      expect(existsSync(failed.output_path)).toBe(true)
      expect(readFileSync(failed.output_path, 'utf8')).toBe(stdout + '\n')
      expect(failed.output_bytes).toBe(new TextEncoder().encode(stdout + '\n').byteLength)

      writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' '${stdout}'\nkill -TERM $$\n`)
      const interrupted = addRun({ agent: '(pending)', job: 'file-question', status: 'running' })
      await expect(run({ job: 'file-question', prompt: 'hello', agent: 'grok', reserveId: interrupted }))
        .rejects.toThrow('cancelled')
      expect(db().query('SELECT status, failure_kind, error FROM run WHERE id=?').get(interrupted))
        .toEqual({ status: 'failed', failure_kind: 'interrupted', error: 'cancelled' })
    } finally {
      grok.bin = previous
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  })

  test('a terminal result without errors or final text is a parse failure', () => {
    const stdout = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'trimmed' }),
      JSON.stringify({ type: 'result', subtype: 'success', errors: [] }),
    ].join('\n')
    expect(AGENTS.grok!.parseReply!(stdout)).toEqual({
      text: '', tokens: null, costUsd: null, error: 'grok result contained no final text',
    })
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


describe('fidelity: did it build what it was asked to build', () => {
  test('correct code that solved the wrong problem is not a perfect run', () => {
    // The failure neither existing axis can see. A complete change set of
    // correct, working code that answers a different question scores full/right
    // on both, and only fidelity registers that it is not what was asked for.
    expect(weigh('full', 'right')).toBe(1)
    expect(weigh('full', 'right', 'drifted')).toBe(0.5)
    expect(weigh('full', 'right', 'faithful')).toBe(1)
  })

  test('asking costs an agent nothing', () => {
    // Load-bearing: the preamble promises the worker that escalating is free.
    // If it were not, asking would cost something after all and nobody would ask.
    expect(FIDELITY_PENALTY.faithful).toBe(0)
  })

  test('a score with no fidelity weighs exactly what it always did', () => {
    // Adding the axis must not restate history. Every read-only job, and every
    // verdict recorded before the column existed, is unaffected.
    for (const d of ['none', 'partial', 'full'] as const) {
      for (const q of ['wrong', 'mixed', 'right'] as const) {
        if (d === 'none') continue
        expect(weigh(d, q, null)).toBe(weigh(d, q))
      }
    }
    expect(weigh('none', null, null)).toBe(weigh('none', null))
  })

  test('the router reads the penalty, not just the printout', () => {
    // The failure this file already documents once: stats, the dashboard and
    // the router each held their own copy of the aggregate and drifted apart.
    const drifted = addRun({ agent: 'codex', job: 'implement' })
    score(drifted, 'full', 'right', 'drifted')
    const c = candidates('implement').find((x) => x.agent === 'codex')!
    expect(c.score).toBeCloseTo(weigh('full', 'right', 'drifted'))
    expect(c.score).toBeLessThan(weigh('full', 'right'))
  })

  test('an agent that drifts ranks below one that asks', () => {
    const asked = addRun({ agent: 'codex', job: 'implement' })
    score(asked, 'full', 'right', 'faithful')
    const guessed = addRun({ agent: 'grok', job: 'implement' })
    score(guessed, 'full', 'right', 'drifted')
    const all = candidates('implement')
    const a = all.find((x) => x.agent === 'codex')!
    const g = all.find((x) => x.agent === 'grok')!
    expect(a.score!).toBeGreaterThan(g.score!)
  })
})


describe('projects are data, not code', () => {
  test('a directory belongs to the project that contains it', () => {
    upsertProject({ name: 'alpha', path: '/w/alpha', stack: 'php-laravel' })
    expect(projectAt('/w/alpha')?.name).toBe('alpha')
    expect(projectAt('/w/alpha/src/deep/file')?.name).toBe('alpha')
    // The case the old path regex could never handle, and the reason
    // containment beats pattern-matching: a worktree lives inside its project.
    expect(projectAt('/w/alpha/.claude/worktrees/orch-12')?.name).toBe('alpha')
    expect(stackAt('/w/alpha/.claude/worktrees/orch-12')).toBe('php-laravel')
  })

  test('an unregistered directory is null, not a guess', () => {
    upsertProject({ name: 'alpha', path: '/w/alpha' })
    expect(projectAt('/somewhere/else')).toBeNull()
    // Not '/w/alphabet': containment must respect the path separator, or a
    // project named as a prefix of another would swallow it.
    expect(projectAt('/w/alphabet')).toBeNull()
  })

  test('the longest matching path wins, so nesting resolves inward', () => {
    upsertProject({ name: 'outer', path: '/w' })
    upsertProject({ name: 'inner', path: '/w/inner' })
    expect(projectAt('/w/inner/src')?.name).toBe('inner')
    expect(projectAt('/w/other')?.name).toBe('outer')
  })

  test('settings survive a round trip', () => {
    upsertProject({
      name: 'alpha', path: '/w/alpha',
      settings: { trunk: 'develop', states: { in_progress: 'active' } },
    })
    const p = projectAt('/w/alpha')!
    expect(p.settings.trunk).toBe('develop')
    expect(p.settings.states?.in_progress).toBe('active')
  })
})

describe('routing narrows to a stack only when that buys a comparison', () => {
  test('one proven agent on a stack is not enough to narrow', () => {
    // Narrowing here would demote an agent with a long job-wide record to
    // "unproven" and hand the work to whichever one reached five on this stack
    // first — the incumbency problem, arriving by a different door.
    for (let i = 0; i < 6; i++) score(addRun({ agent: 'codex', job: 'craft', stack: 'php' }), 'full', 'right')
    for (let i = 0; i < 9; i++) score(addRun({ agent: 'grok', job: 'craft', stack: 'node' }), 'full', 'right')
    expect(evidenceFor('craft', 0, 'php').level).toBe('job')
  })

  test('two proven agents on a stack is a real comparison', () => {
    for (let i = 0; i < 6; i++) score(addRun({ agent: 'codex', job: 'craft', stack: 'php' }), 'full', 'right')
    for (let i = 0; i < 6; i++) score(addRun({ agent: 'grok', job: 'craft', stack: 'php' }), 'full', 'mixed')
    const ev = evidenceFor('craft', 0, 'php')
    expect(ev.level).toBe('stack')
    expect(ev.stack).toBe('php')
  })

  test('evidence from another stack does not leak into a scoped view', () => {
    for (let i = 0; i < 6; i++) score(addRun({ agent: 'codex', job: 'craft', stack: 'php' }), 'full', 'right')
    for (let i = 0; i < 6; i++) score(addRun({ agent: 'grok', job: 'craft', stack: 'php' }), 'full', 'right')
    // A disaster on a different stack must not touch the php verdict.
    for (let i = 0; i < 9; i++) addRun({ agent: 'codex', job: 'craft', stack: 'node', status: 'failed' })
    const scoped = evidenceFor('craft', 0, 'php').cands.find((c) => c.agent === 'codex')!
    expect(scoped.evidence).toBe(6)
    expect(scoped.score).toBe(weigh('full', 'right'))
  })

  test('no stack at all behaves exactly as it always did', () => {
    for (let i = 0; i < 6; i++) score(addRun({ agent: 'codex', job: 'craft' }), 'full', 'right')
    expect(evidenceFor('craft', 0, null).level).toBe('job')
    expect(evidenceFor('craft', 0, undefined).cands.find((c) => c.agent === 'codex')!.evidence).toBe(6)
  })
})


describe('the fidelity penalty cannot sink below "nothing arrived"', () => {
  test('a delivered answer never ranks below a non-delivery', () => {
    // Unclamped, partial/wrong/drifted weighs -0.75 against none's -0.5, so an
    // agent that delivered something unusable ranked BELOW one that delivered
    // nothing — and routing would prefer the agent that cannot do the job.
    const floor = weigh('none', null)
    for (const d of ['partial', 'full'] as const) {
      for (const q of ['wrong', 'mixed', 'right'] as const) {
        for (const f of ['drifted', 'partial', 'faithful'] as const) {
          expect(weigh(d, q, f)).toBeGreaterThanOrEqual(floor)
        }
      }
    }
  })

  test('the router clamps identically to the printout', () => {
    const bad = addRun({ agent: 'codex', job: 'implement' })
    score(bad, 'partial', 'wrong', 'drifted')
    const c = candidates('implement').find((x) => x.agent === 'codex')!
    expect(c.score).toBeCloseTo(weigh('partial', 'wrong', 'drifted'))
    expect(c.score).toBeGreaterThanOrEqual(weigh('none', null))
  })

  test('an unknown fidelity is refused rather than read as no penalty', () => {
    // addColumn cannot carry a CHECK, so a typo reaches weigh() on any database
    // that predates the column. Silently scoring it as faithful would flatter
    // the run and diverge from the SQL, which treats it as zero.
    expect(() => weigh('full', 'right', 'faithfull' as never)).toThrow()
  })
})


describe('the Stop hook and orch agree on what is unscored', () => {
  test("the hook's SQL carries every clause of UNSCORED_WHERE", () => {
    /**
     * The hook is Python and cannot import the TypeScript definition, so its
     * predicate is a second copy — and it did what a second copy always does.
     * `UNSCORED_WHERE` learned that a conversation is one unit of work; the
     * hook did not, and spent a session demanding verdicts on two runs that
     * `orch score` refuses to take, naming their root instead.
     *
     * This cannot make them one definition. It can make them fail together,
     * which is the same guarantee the router and the dashboard get from
     * sharing `scoreboard()`.
     */
    const hook = readFileSync(
      new URL('../hooks/score-reminder.py', import.meta.url).pathname, 'utf8',
    )
    // Each clause of the real predicate, normalised to how SQL is written in
    // both files. If UNSCORED_WHERE grows a condition, this fails until the
    // hook grows it too.
    for (const clause of UNSCORED_WHERE.split('AND').map((c) => c.trim().replace(/\s+/g, ' '))) {
      expect(hook.replace(/\s+/g, ' ')).toContain(clause)
    }
  })
})


describe('a project can declare a worktree instead of writing one', () => {
  test('a derived database name is safe for both engines', () => {
    // Postgres folds unquoted identifiers to lower case and MySQL forbids most
    // punctuation, so the safe intersection is what this must produce — a name
    // needing quotes is a name that will one day be used unquoted.
    expect(dbNameFor('Star-Ship', 42)).toBe('star_ship_wt_42')
    expect(dbNameFor('my.app', 7)).toBe('my_app_wt_7')
    expect(dbNameFor('', 1)).toBe('app_wt_1')
    expect(dbNameFor('--weird--', 9)).toBe('weird_wt_9')
  })

  test('a recipe stops at its first failure and reports which step', () => {
    // A half-provisioned tree is the worst outcome available: a worker runs the
    // suite in it, the suite passes against nothing, and the run comes back
    // green. So the steps after a failure must not run.
    const dir = mkdtempSync(join(tmpdir(), 'recipe-'))
    const steps = runRecipe(
      { install: 'exit 3', migrate: 'touch SHOULD-NOT-EXIST' }, dir, 'db_wt_1', '',
    )
    expect(steps.at(-1)!.ok).toBe(false)
    expect(steps.at(-1)!.step).toBe('install')
    expect(existsSync(join(dir, 'SHOULD-NOT-EXIST'))).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  test('the env file is appended, so an inherited one survives', () => {
    // These files inherit the checkout's and add a managed block. Most loaders
    // are last-wins, which is what makes the inheritance safe rather than a
    // source of silent disagreement — so the generated block must come last and
    // must not replace what was there.
    const dir = mkdtempSync(join(tmpdir(), 'recipe-'))
    writeFileSync(join(dir, '.env'), 'INHERITED=yes\n')
    runRecipe({ env: { path: '.env', contents: 'DB={db}' } }, dir, 'db_wt_5', '')
    const out = readFileSync(join(dir, '.env'), 'utf8')
    expect(out).toContain('INHERITED=yes')
    expect(out.indexOf('DB=db_wt_5')).toBeGreaterThan(out.indexOf('INHERITED=yes'))
    rmSync(dir, { recursive: true, force: true })
  })

  test('a worker is warned off somebody else\'s server', () => {
    // The failure this exists to prevent does not announce itself: borrowing a
    // running server tests a different branch's bundle and PASSES.
    const notes = recipeNotes({ serve: 'bun dev --port {port}', database: { kind: 'none' } }, 'x', '8080')
    expect(notes).toContain('NEVER verify against a server you did not start')
    expect(notes).toContain('8080')
  })

  test('an empty recipe is plain git, which is right where a checkout is just files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recipe-'))
    expect(runRecipe({}, dir, 'db_wt_1', '')).toEqual([])
    rmSync(dir, { recursive: true, force: true })
  })
})


describe('what stopped an agent is reported, not silently worked around', () => {
  test("a review's FINDING is not the reviewer's own blocker", () => {
    // Both of these are real lines from real runs, and the first version of the
    // detector counted both as blockers. Neither agent was blocked by anything;
    // both were doing their job well and describing somebody else's code.
    expect(detectBlockers(
      '`check-ledger.ts:233` names `bun run refresh` instead of a raw port on ECONNREFUSED.',
    )).toEqual([])
    expect(detectBlockers(
      'If process.kill() throws for another reason (e.g. EPERM — permission denied), the code treats it the same.',
    )).toEqual([])
  })

  test('an agent saying it could not run something IS a blocker', () => {
    // Quoted from the run that downgraded its whole test verdict because of it.
    const found = detectBlockers(
      'Could not verify by execution: Docker access was denied at /workspace/.docker/run/docker.sock, so PHPUnit could not run.',
    )
    expect(found.map((b) => b.kind)).toContain('docker-denied')
  })

  test('a blocker is counted once however often it is mentioned', () => {
    // An agent that says it twice has one blocker, and a count is the whole
    // point: one denied socket is an anecdote, forty is a machine to fix.
    const found = detectBlockers(
      'Docker access was denied.\nAgain: docker access was denied when I retried.',
    )
    expect(found.filter((b) => b.kind === 'docker-denied')).toHaveLength(1)
  })

  test('nothing reported is nothing detected', () => {
    expect(detectBlockers('The logs contain: Docker access denied.')).toEqual([])
    expect(detectBlockers('Everything ran. 42 tests passed.')).toEqual([])
    expect(detectBlockers('')).toEqual([])
  })
})

describe('an agent gets the toolchain of a project someone registered', () => {
  test('a registered project executes; an unregistered directory does not', () => {
    // The boundary is the register, not a flag: a repository someone
    // deliberately registered is one whose toolchain the work requires, and a
    // directory an agent merely got pointed at is not.
    upsertProject({ name: 'mine', path: '/w/mine' })
    expect(projectAt('/w/mine')?.settings.agentSandbox).toBeUndefined()
    expect(projectAt('/somewhere/else')).toBeNull()
  })

  test('a project can narrow itself without a code change', () => {
    upsertProject({ name: 'careful', path: '/w/careful', settings: { agentSandbox: 'read-only' } })
    expect(projectAt('/w/careful')!.settings.agentSandbox).toBe('read-only')
  })

  test('exec is what the widest level actually asks codex for', () => {
    const argv = AGENTS.codex!.argv({ prompt: 'p', out: '/tmp/o', sandbox: 'exec' })
    expect(argv).toContain(CODEX_EXEC_SANDBOX)
    // And the narrow levels stay narrow.
    expect(AGENTS.codex!.argv({ prompt: 'p', out: '/tmp/o' })).toContain('read-only')
    expect(AGENTS.codex!.argv({ prompt: 'p', out: '/tmp/o', sandbox: 'workspace-write' }))
      .toContain('workspace-write')
  })

  test('asking for MCP gives up exec, and that is the intended trade', () => {
    // --approve-for-me is required for MCP and is mutually exclusive with
    // --sandbox. Review lenses get execution and use no MCP; implementation
    // workers keep the ask channel, because a worker that cannot ask guesses.
    const argv = AGENTS.codex!.argv({ prompt: 'p', out: '/tmp/o', sandbox: 'exec', mcp: true })
    expect(argv).toContain('--approve-for-me')
    expect(argv).not.toContain(CODEX_EXEC_SANDBOX)
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

describe('the exit code decides a signal death, not the vendor prose', () => {
  test("codex's echoed banner no longer reads as a plain failure", () => {
    // codex prints a banner and echoes the prompt to stderr, so a harness kill
    // arrived as screens of its own input and was classified `other` —
    // charging the agent for a process group somebody else killed.
    const banner = 'OpenAI Codex v0.5\n workdir: /x\n model: gpt-5\n<the whole prompt echoed>'
    expect(classify(banner, 143)).toBe('interrupted')
  })

  test('a prompt that merely discusses timeouts is not a timeout', () => {
    // The timeout pattern matched words inside the echoed prompt: one run was
    // filed as a timeout because its own prompt was about timeouts.
    expect(classify('the spec discusses timeout handling in detail', 143)).toBe('interrupted')
  })

  test('our own timer is a timeout; a harness kill is not', () => {
    // Both arrive as SIGTERM, so the exit code cannot separate them — only the
    // caller knows which fired. Ours is a fact about the agent, a harness kill
    // is a fact about the room, and only the second is excluded from evidence.
    expect(classify('no reply within 20m', 143, true)).toBe('timeout')
    expect(classify('no reply within 20m', 143, false)).toBe('interrupted')
  })

  test('an ordinary failure is still read from its text', () => {
    expect(classify('HTTP 429: rate limit exceeded', 1)).toBe('quota')
    expect(classify('upstream request timed out', 1)).toBe('timeout')
    expect(classify('something broke', 1)).toBe('other')
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


describe('canonical schema rebuild', () => {
  /**
   * The CREATE TABLE migrate() used to ship, before every grafted column was
   * folded in. Copied, not reconstructed, so the rebuild is tested against the
   * definition an existing file actually has.
   */
  const OLD_RUN_DDL = `CREATE TABLE IF NOT EXISTS run (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at    TEXT NOT NULL,
      agent         TEXT NOT NULL,
      job           TEXT NOT NULL,
      repo          TEXT,
      cwd           TEXT,
      prompt_sha    TEXT NOT NULL,
      prompt_bytes  INTEGER NOT NULL,
      prompt_head   TEXT NOT NULL,
      latency_ms    INTEGER,
      exit_code     INTEGER,
      output_bytes  INTEGER,
      output_path   TEXT,
      prompt_path   TEXT,
      vendor_tokens INTEGER,
      vendor_cost_usd REAL,
      probe         INTEGER NOT NULL DEFAULT 0,
      failure_kind  TEXT,
      status        TEXT NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running','ok','failed','stale','asking','blocked')),
      error         TEXT
    )`
  const OLD_SCORE_DDL = `CREATE TABLE IF NOT EXISTS score (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id    INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
      delivery  TEXT NOT NULL CHECK (delivery IN ('none','partial','full')),
      quality   TEXT CHECK (quality IN ('wrong','mixed','right')),
      fidelity  TEXT,
      note      TEXT,
      scored_at TEXT NOT NULL,
      scored_by TEXT NOT NULL DEFAULT 'claude',
      CHECK ((delivery = 'none') = (quality IS NULL))
    )`

  const cols = (d: Database, table: string) =>
    (d.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)

  const tableSql = (d: Database, name: string) =>
    (d.query(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(name) as { sql: string }).sql

  const metaVersion = (d: Database) =>
    (d.query(`SELECT value FROM schema_meta WHERE key='schema'`).get() as { value: string } | null)?.value ?? null

  function openOld(path: string): Database {
    const d = new Database(path)
    d.exec(OLD_RUN_DDL)
    d.exec(OLD_SCORE_DDL)
    d.exec(
      `INSERT INTO run (started_at, agent, job, prompt_sha, prompt_bytes, prompt_head, status)
       VALUES ('2026-01-01T00:00:00.000Z', 'codex', 'implement', 'sha', 10, 'keep-me', 'blocked')`,
    )
    d.exec(
      `INSERT INTO score (run_id, delivery, quality, fidelity, scored_at)
       VALUES (1, 'full', 'right', 'faithful', '2026-01-01T00:00:00.000Z')`,
    )
    applySchema(d)
    return d
  }

  test('an old database opens, is rebuilt, keeps its rows, and enforces the new CHECKs', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'orch-schema-')), 'old.db')
    const d = openOld(path)
    expect(cols(d, 'run')).toEqual(cols(db(), 'run'))
    expect(cols(d, 'score')).toEqual(cols(db(), 'score'))
    expect(d.query('SELECT id, prompt_head, status FROM run').get()).toEqual(
      { id: 1, prompt_head: 'keep-me', status: 'asking' },
    )
    expect(d.query('SELECT fidelity FROM score WHERE run_id=1').get()).toEqual({ fidelity: 'faithful' })
    expect(() => d.exec("UPDATE run SET status='blocked' WHERE id=1")).toThrow()
    expect(() => d.exec("UPDATE score SET fidelity='typo' WHERE run_id=1")).toThrow()
    d.close()
  })

  test('a fresh database opens without a rebuild (meta version matches)', () => {
    const sql = tableSql(db(), 'run')
    expect(sql.startsWith('CREATE TABLE run')).toBe(true)
    expect(sql.startsWith('CREATE TABLE "run"')).toBe(false)
    const version = metaVersion(db())
    expect(version).toMatch(/^[0-9a-f]{64}$/)
    const path = join(mkdtempSync(join(tmpdir(), 'orch-schema-')), 'fresh.db')
    const d = new Database(path)
    applySchema(d)
    expect(metaVersion(d)).toBe(version)
    const freshSql = tableSql(d, 'run')
    expect(freshSql.startsWith('CREATE TABLE run')).toBe(true)
    expect(freshSql.startsWith('CREATE TABLE "run"')).toBe(false)
    d.close()
  })

  test('opening twice is idempotent', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'orch-schema-')), 'twice.db')
    const d = openOld(path)
    const first = {
      runSql: tableSql(d, 'run'),
      scoreSql: tableSql(d, 'score'),
      version: metaVersion(d),
      run: d.query('SELECT id, prompt_head, status FROM run').all(),
      score: d.query('SELECT run_id, delivery, quality, fidelity FROM score').all(),
      runCols: cols(d, 'run'),
      scoreCols: cols(d, 'score'),
    }
    applySchema(d)
    expect(tableSql(d, 'run')).toBe(first.runSql)
    expect(tableSql(d, 'score')).toBe(first.scoreSql)
    expect(metaVersion(d)).toBe(first.version)
    expect(d.query('SELECT id, prompt_head, status FROM run').all()).toEqual(first.run)
    expect(d.query('SELECT run_id, delivery, quality, fidelity FROM score').all()).toEqual(first.score)
    expect(cols(d, 'run')).toEqual(first.runCols)
    expect(cols(d, 'score')).toEqual(first.scoreCols)
    d.close()
  })
})

describe('scoped operator docs', () => {
  test('CRUD round-trips and set is a uniqueness-preserving upsert', () => {
    const first = setDoc({ scope: 'global', subject: null, slug: 'hello', title: 'Hello', body: 'one' })
    expect(getDoc('global', null, 'hello')?.body).toBe('one')
    const second = setDoc({ scope: 'global', subject: null, slug: 'hello', title: 'Hello again', body: 'two' })
    expect(second.id).toBe(first.id)
    expect(listDocs()).toHaveLength(1)
    expect(second.created_at).toBe(first.created_at)
    expect(second.body).toBe('two')
    expect(removeDoc('global', null, 'hello')).toBe(true)
    expect(getDoc('global', null, 'hello')).toBeNull()
  })

  test('scope, slug, and every subject rule name a usable fix', () => {
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    const put = (scope: string, subject: string | null, slug = 'ok') =>
      setDoc({ scope, subject, slug, title: 'T', body: 'B' })
    expect(() => put('global', null, 'Bad')).toThrow('1-64')
    expect(() => put('global', null, 'a'.repeat(65))).toThrow('1-64')
    expect(() => put('unknown', null)).toThrow('valid scopes')
    expect(() => put('project', 'missing')).toThrow('valid values: known')
    expect(() => put('agent', 'missing')).toThrow(`valid values:`)
    expect(() => put('job', 'missing')).toThrow(`valid values:`)
    expect(() => put('machine', 'host')).toThrow('remove --subject')
    expect(() => put('global', 'all')).toThrow('remove --subject')
    expect(() => put('project', null)).toThrow('require --subject')
  })

  test('docsForRun orders global, job, then project and omits absent scopes', () => {
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    expect(docsForRun({ job: 'file-question', cwd: '/elsewhere' })).toEqual([])
    setDoc({ scope: 'project', subject: 'known', slug: 'project', title: 'Project', body: 'P' })
    setDoc({ scope: 'job', subject: 'file-question', slug: 'job', title: 'Job', body: 'J' })
    setDoc({ scope: 'global', subject: null, slug: 'global', title: 'Global', body: 'G' })
    setDoc({ scope: 'agent', subject: 'codex', slug: 'agent', title: 'Agent', body: 'A' })
    setDoc({ scope: 'machine', subject: null, slug: 'machine', title: 'Machine', body: 'M' })
    expect(docsForRun({ job: 'file-question', cwd: '/w/known/src' }).map((d) => d.title))
      .toEqual(['Global', 'Job', 'Project'])
  })

  test('export and import preserve title and markdown body', () => {
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    setDoc({ scope: 'global', subject: null, slug: 'quoted', title: 'A "title"', body: '# Body\n\nText\n' })
    setDoc({ scope: 'project', subject: 'known', slug: 'project', title: 'Project', body: 'Estate' })
    const target = mkdtempSync(join(tmpdir(), 'orch-doc-export-'))
    try {
      expect(exportDocs(target)).toBe(2)
      db().exec('DELETE FROM doc')
      expect(importDocs(target)).toBe(2)
      expect(getDoc('global', null, 'quoted')).toMatchObject({ title: 'A "title"', body: '# Body\n\nText\n' })
      expect(getDoc('project', 'known', 'project')?.body).toBe('Estate')
    } finally { rmSync(target, { recursive: true, force: true }) }
  })

  test('brief contains global then current-project markdown, and is empty otherwise', () => {
    expect(brief('/nowhere')).toBe('')
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    setDoc({ scope: 'project', subject: 'known', slug: 'p', title: 'Project', body: 'P' })
    setDoc({ scope: 'global', subject: null, slug: 'g', title: 'Global', body: 'G' })
    expect(brief('/w/known/src')).toBe('## Global\n\nG\n\n## Project\n\nP')
  })

  test('first-turn bound prompts inject docs and count them; resumes do neither', async () => {
    upsertProject({ name: 'known', path: dir, stack: null, canon: true, settings: {} })
    setDoc({ scope: 'global', subject: null, slug: 'g', title: 'Global', body: 'G' })
    setDoc({ scope: 'job', subject: 'file-question', slug: 'j', title: 'Job', body: 'J' })
    setDoc({ scope: 'project', subject: 'known', slug: 'p', title: 'Project', body: 'P' })
    const script = join(dir, 'docs-agent.ts')
    writeFileSync(script, 'process.stdout.write("ok")\n')
    const agent = AGENTS.codex!
    const origBin = agent.bin
    const origArgv = agent.argv
    const origResume = agent.resumeArgv
    let resumedPrompt = ''
    agent.bin = process.execPath
    agent.argv = () => [script]
    agent.resumeArgv = ({ prompt }) => { resumedPrompt = prompt; return [script] }
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      const first = await runJob({ job: 'file-question', prompt: 'FIRST SPEC', cwd: dir, agent: 'codex' })
      const firstRow = db().query('SELECT prompt_path, docs_injected FROM run WHERE id=?').get(first.id) as
        { prompt_path: string; docs_injected: number }
      const bound = readFileSync(firstRow.prompt_path.replace(/\.prompt\.txt$/, '.bound.txt'), 'utf8')
      expect(bound).toContain('WHAT THE OPERATOR WANTS YOU TO KNOW\n\n## Global\n\nG\n\n## Job\n\nJ\n\n## Project\n\nP')
      expect(firstRow.docs_injected).toBe(3)
      db().query('UPDATE run SET vendor_session=? WHERE id=?').run('docs-session', first.id)
      const resumed = await runJob({
        job: 'file-question', prompt: 'RULING', cwd: dir,
        resume: { parent: first.id, agent: 'codex', session: 'docs-session', turn: 2,
          sessionId: 'owner', worktree: null },
      })
      expect(resumedPrompt).not.toContain('WHAT THE OPERATOR WANTS YOU TO KNOW')
      expect((db().query('SELECT docs_injected FROM run WHERE id=?').get(resumed.id) as
        { docs_injected: number }).docs_injected).toBe(0)
    } finally {
      agent.bin = origBin
      agent.argv = origArgv
      agent.resumeArgv = origResume
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(script, { force: true })
    }
  })

  test('MCP list_docs and get_doc work through linked in-memory transports', async () => {
    setDoc({ scope: 'global', subject: null, slug: 'mcp', title: 'MCP', body: 'Visible' })
    const server = createDocsMcpServer()
    const client = new Client({ name: 'orch-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const listed = await client.callTool({ name: 'list_docs', arguments: { scope: 'global' } })
      const fetched = await client.callTool({ name: 'get_doc', arguments: { scope: 'global', slug: 'mcp' } })
      const listedText = ((listed as any).content[0] as { text: string }).text
      const fetchedText = ((fetched as any).content[0] as { text: string }).text
      expect(JSON.parse(listedText)).toHaveLength(1)
      expect(JSON.parse(fetchedText).body).toBe('Visible')
    } finally {
      await client.close()
      await server.close()
    }
  })

  const CLI = new URL('cli.ts', import.meta.url).pathname
  const orchCli = (args: string[], stdin?: string) => {
    const p = Bun.spawnSync([process.execPath, CLI, ...args], {
      env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
      stdin: stdin !== undefined ? new TextEncoder().encode(stdin) : undefined,
      stdout: 'pipe', stderr: 'pipe',
    })
    return {
      code: p.exitCode,
      out: new TextDecoder().decode(p.stdout),
      err: new TextDecoder().decode(p.stderr),
    }
  }

  test('orch doc subjects --json lists project, agent and job names', () => {
    upsertProject({ name: 'known', path: '/w/known', stack: null, canon: true, settings: {} })
    const r = orchCli(['doc', 'subjects', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out)).toEqual({
      project: ['known'],
      agent: Object.keys(AGENTS).sort(),
      job: Object.keys(JOBS).sort(),
    })
    expect(docSubjects()).toEqual(JSON.parse(r.out))
  })

  test('orch doc rm --json reports whether a row was removed', () => {
    setDoc({ scope: 'global', subject: null, slug: 'gone', title: 'T', body: 'B' })
    const hit = orchCli(['doc', 'rm', 'gone', '--scope', 'global', '--json'])
    expect(hit.code).toBe(0)
    expect(JSON.parse(hit.out)).toEqual({ removed: true })
    const miss = orchCli(['doc', 'rm', 'gone', '--scope', 'global', '--json'])
    expect(miss.code).toBe(0)
    expect(JSON.parse(miss.out)).toEqual({ removed: false })
  })

  test('orch doc set --json round-trips a body with quote, backtick and newline', () => {
    const body = "quote' backtick` newline\n"
    const r = orchCli(
      ['doc', 'set', 'round-trip', '--scope', 'global', '--title', 'T', '--json'],
      body,
    )
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out).body).toBe(body)
    expect(getDoc('global', null, 'round-trip')?.body).toBe(body)
  })
})
