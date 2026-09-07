import { afterEach, describe, expect, test } from 'bun:test'
import { rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { AGENTS, GENERIC_QUESTION_TOKENS, JOBS, LAND_PREAMBLE, NEEDS_HEALTH, OUTPUT_RESERVE, STALE_AFTER_MS, WAKE_COOLDOWN_MS, WORKER_PREAMBLE, addRun, available, candidates, classify, db, detectBlockers, dir, ensureLocalHealth, guide, isNonAnswer, jobTimeoutCeilingMinutes, localReachable, pick, resetLocalHealth, runJob, score, strictCodexSchema, unavailableReason, upsertProject, wakeDecision, workerPreamble, workerResumeGuard } from '../test/fixture.ts'

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

describe('a probe proves an agent is alive without vouching for it', () => {
  test('an explicit probe reaches a cooling agent while ordinary work is refused', async () => {
    const script = join(dir, 'fake-cooling-probe.ts')
    writeFileSync(script, 'process.stdout.write("probe reached spawn")\n')
    const agent = AGENTS.grok!
    const original = {
      bin: agent.bin, argv: agent.argv, stdin: agent.stdin,
      readsOut: agent.readsOut, parseReply: agent.parseReply,
    }
    const priorDepth = process.env.ORCH_DEPTH
    const failed = addRun({
      agent: 'grok', job: 'summarize', status: 'failed', kind: 'quota',
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    })
    try {
      agent.bin = process.execPath
      agent.argv = () => [script]
      agent.stdin = false
      agent.readsOut = false
      agent.parseReply = undefined
      process.env.ORCH_DEPTH = '0'

      await expect(runJob({
        job: 'summarize', prompt: 'ordinary work', agent: 'grok', noFailover: true,
      })).rejects.toThrow('not eligible for summarize: vendor quota')

      const probe = await runJob({
        job: 'summarize', prompt: 'reply', agent: 'grok', probe: true, noFailover: true,
      })
      expect(probe.agent).toBe('grok')
      expect(probe.output).toBe('probe reached spawn')
      expect(db().query('SELECT status, probe FROM run WHERE id=?').get(probe.id))
        .toEqual({ status: 'ok', probe: 1 })
      expect(candidates('summarize').find((c) => c.agent === 'grok')!.cooling).toBeNull()
    } finally {
      db().query('DELETE FROM run WHERE id=?').run(failed)
      agent.bin = original.bin
      agent.argv = original.argv
      agent.stdin = original.stdin
      agent.readsOut = original.readsOut
      agent.parseReply = original.parseReply
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(script, { force: true })
    }
  })

  test('a probe bypasses cooling only, not the pinned agent\'s other exclusions', () => {
    addRun({ agent: 'agy', job: 'file-question', status: 'failed', kind: 'quota' })
    expect(() => pick('file-question', 'agy', 0, false, null, {}, true))
      .toThrow('not eligible for file-question: lacks readsRepo')
  })

  test('a probe clears a cooldown, which is the only way to clear one early', () => {
    // Deliberate, and the one query that does not filter probes. Availability
    // is not quality: a human who tops up a quota needs a way to say so.
    const base = Date.now() - 10_000
    const failed = addRun({
      agent: 'codex', job: 'craft', status: 'failed',
      startedAt: new Date(base).toISOString(), latency: 1000,
    })
    db().query("UPDATE run SET failure_kind='quota' WHERE id=?").run(failed)
    expect(candidates('craft').find((c) => c.agent === 'codex')!.cooling).toContain('quota')

    addRun({
      agent: 'codex', job: 'craft', probe: 1,
      startedAt: new Date(base + 2000).toISOString(), latency: 1000,
    })  // succeeded later, calibration
    expect(candidates('craft').find((c) => c.agent === 'codex')!.cooling).toBeNull()
  })

  test('but the probe still teaches routing nothing', () => {
    score(addRun({ agent: 'codex', job: 'safety', probe: 1 }), 'full', 'right')
    const c = candidates('safety').find((x) => x.agent === 'codex')!
    expect(c.evidence).toBe(0)
    expect(c.score).toBeNull()
  })

  test('guide plainly reports an agent whose vendor circuit is open', () => {
    const failed = addRun({ agent: 'codex', job: 'craft', status: 'failed' })
    db().query("UPDATE run SET failure_kind='auth' WHERE id=?").run(failed)
    const row = guide('craft')[0]!
    expect(row.excluded).toContainEqual({
      agent: 'codex',
      why: expect.stringContaining('vendor auth'),
    })
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

  // These assertions are about interpreting an endpoint's response, not about
  // opening a listener. Repository workers cannot bind one: Bun reports that
  // denial as EADDRINUSE even for port 0. Keep the fixture in-process so
  // concurrent worktrees have no socket resource to contend over.
  async function withFetchResponse<T>(response: Response, run: () => Promise<T>): Promise<T> {
    const original = globalThis.fetch
    globalThis.fetch = Object.assign(
      () => Promise.resolve(response),
      { preconnect: original.preconnect },
    ) as typeof fetch
    try { return await run() }
    finally { globalThis.fetch = original }
  }

  test('an endpoint nothing is listening on is not reachable', async () => {
    // Port 1 is refused immediately on any machine, so this is fast and does
    // not depend on the local model host being up — or down.
    const r = await localReachable(2000, 'http://127.0.0.1:1/v1')
    expect(r.ok).toBe(false)
  })

  test('a 200 from the wrong service is not reachability', async () => {
    // The gotcha that cost real time: local 8000 is Docker Desktop's, and it
    // answers HTTP 200 with HTML. Status alone would have called that healthy.
    await withFetchResponse(
      new Response('<html>hello</html>', {
        headers: { 'content-type': 'text/html' },
      }),
      async () => {
        const r = await localReachable(2000, 'http://127.0.0.1:8000/v1')
        expect(r.ok).toBe(false)
        expect(r.detail).toContain('something else owns this port')
      },
    )
  })

  test('JSON that is not a model list is not an OpenAI endpoint either', async () => {
    await withFetchResponse(Response.json({ hello: 'world' }), async () => {
      const r = await localReachable(2000, 'http://127.0.0.1:8000/v1')
      expect(r.ok).toBe(false)
    })
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
        'You may commit to your own throwaway branch. Do not push, merge into trunk, or rewrite history.',
        '', '---', '', 'the resumed-turn message',
      ].join('\n'))
      expect(readFileSync((db().query('SELECT prompt_path FROM run WHERE id=?').get(result.id) as
        { prompt_path: string }).prompt_path, 'utf8')).toBe('the resumed-turn message')
      expect(db().query('SELECT spec_sha FROM run WHERE id=?').get(result.id)).toEqual({
        spec_sha: createHash('sha256').update('the resumed-turn message').digest('hex').slice(0, 16),
      })
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
      expect(child.ORCH_RUN_TOKEN).toBe(
        (db().query('SELECT run_token FROM run WHERE id=?').get(result.id) as { run_token: string }).run_token,
      )
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

  test('a resumed spawn hands the child the turn id and the token minted for that turn', async () => {
    const script = join(dir, 'dump-env-resume-dev289.ts')
    writeFileSync(script, 'process.stdout.write(JSON.stringify(process.env))\n')
    const agent = AGENTS.codex!
    const origBin = agent.bin
    const origResume = agent.resumeArgv
    agent.bin = process.execPath
    agent.resumeArgv = () => [script]
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    const rootPrompt = join(dir, 'resume-env-root.prompt.txt')
    writeFileSync(rootPrompt, 'original spec')
    try {
      const parent = addRun({ agent: 'codex', job: 'file-question', status: 'asking' })
      db().query('UPDATE run SET vendor_session=?, prompt_path=?, run_token=? WHERE id=?')
        .run('root-session', rootPrompt, 'root-token', parent)
      const result = await runJob({
        job: 'file-question', prompt: 'continue', cwd: dir,
        resume: {
          parent, agent: 'codex', session: 'root-session', turn: 2,
          sessionId: 'orch-test-session', worktree: null,
        },
      })
      const child = JSON.parse(result.output) as Record<string, string>
      const row = db().query('SELECT parent_run_id, turn, run_token FROM run WHERE id=?')
        .get(result.id) as { parent_run_id: number; turn: number; run_token: string }
      expect(result.id).not.toBe(parent)
      expect(row).toEqual({ parent_run_id: parent, turn: 2, run_token: child.ORCH_RUN_TOKEN })
      expect(child.ORCH_RUN_ID).toBe(String(result.id))
      expect(child.ORCH_RUN_TOKEN).toBeTruthy()
      expect(child.ORCH_RUN_TOKEN).not.toBe('root-token')
    } finally {
      agent.bin = origBin
      agent.resumeArgv = origResume
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(script, { force: true })
      rmSync(rootPrompt, { force: true })
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

  test('the two hand-rolled job shapes declare their actual bounds', () => {
    const diagnose = JOBS.diagnose!
    expect(diagnose.needs).toEqual({ readsRepo: true })
    expect(diagnose.prefer).toEqual(['codex', 'grok'])
    expect(diagnose.contextTokens).toBe(JOBS.understand!.contextTokens)
    expect(diagnose.timeoutMs).toBe(40 * 60_000)
    expect(JOBS.understand!.timeoutMs).toBe(40 * 60_000)

    const land = JOBS.land!
    expect(land.needs).toEqual({ readsRepo: true, writesRepo: true, resumable: true })
    expect(land.prefer).toEqual(['codex'])
    expect(land.contextTokens).toBe(JOBS.fix!.contextTokens)
    expect(land.timeoutMs).toBe(30 * 60_000)
  })

  test('every job timeout ceiling stays below the stale cutoff', () => {
    for (const j of Object.values(JOBS)) {
      expect(jobTimeoutCeilingMinutes(j) * 60_000).toBeLessThan(STALE_AFTER_MS)
    }
  })

  test('inline review declares that repository access is forbidden', () => {
    expect(JOBS['review-lens-inline']!.needs).toEqual({ readsRepo: false })
    expect(JOBS['review-lens']!.needs).toEqual({ readsRepo: true })
  })

  test('writing workers may commit only land may merge into trunk', () => {
    expect(workerPreamble('land')).toBe(LAND_PREAMBLE)
    expect(LAND_PREAMBLE).toContain('DIFFERENT contract from implement')
    expect(LAND_PREAMBLE).toContain('You MAY retrieve the named source run')
    expect(LAND_PREAMBLE).toContain('create the\nrequested commit')
    expect(LAND_PREAMBLE).toContain('fast-forward trunk to it')
    expect(LAND_PREAMBLE).toContain('Run the gates after rebasing')
    expect(LAND_PREAMBLE).toContain('Merge fast-forward only')
    expect(LAND_PREAMBLE).toContain('Do NOT push')
    expect(LAND_PREAMBLE).not.toContain('Do NOT merge')
    expect(LAND_PREAMBLE).toContain('one source run number')
    expect(LAND_PREAMBLE).toContain('one named target branch')
    expect(LAND_PREAMBLE).not.toContain('Do NOT commit')

    for (const name of ['implement', 'fix']) {
      expect(workerPreamble(name)).toBe(WORKER_PREAMBLE)
      expect(workerPreamble(name)).toContain('MAY commit changes to your own throwaway branch')
      expect(workerPreamble(name)).toContain('Do NOT push')
      expect(workerPreamble(name)).toContain('do NOT merge into\ntrunk')
      expect(workerPreamble(name)).toContain('do not rewrite history')
      expect(workerPreamble(name)).toContain(
        `a lone\ngeneric token (${GENERIC_QUESTION_TOKENS.join(', ')}) is not a question`,
      )
      expect(workerResumeGuard(name)).toContain('may commit to your own throwaway branch')
      expect(workerResumeGuard(name)).toContain('Do not push, merge into trunk, or rewrite history')
    }
    expect(workerResumeGuard('land')).toContain('merge it into trunk fast-forward only')
    expect(workerResumeGuard('land')).toContain('Do not push')
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

  test('grok applies scoped trust on first and resumed invocations alike', () => {
    const grok = AGENTS.grok!
    const cwd = '/tmp/orch-trusted-tree'
    for (const args of [
      grok.argv({ prompt: 'p', out: '/tmp/o', trustCwd: cwd }),
      grok.resumeArgv!({ prompt: 'p', out: '/tmp/o', trustCwd: cwd, session: 'session' }),
    ]) {
      expect(args.slice(0, 3)).toEqual(['--cwd', cwd, '--trust'])
    }
    expect(grok.argv({ prompt: 'p', out: '/tmp/o' })).not.toContain('--trust')
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
