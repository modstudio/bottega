import { describe, expect, test } from 'bun:test'
import { rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ReviewReply, WorkerReply } from './contract.ts'
import { runJson, AGENTS, CANON_EVALS, CANON_EVAL_LENS, TRACKED_EVAL_PATH, UNTRACKED_EVAL_PATH, addRun, canonEvalsReport, currentCanonEvalSha, db, dir, failingCanonEvalSlugs, hermeticGitEnv, lastCanonEvalAt, nowIso, runCanonEvals, summary, upsertProject, workerReply } from '../test/fixture.ts'

describe('metric canon headline and calendar halves', () => {
  test('counts each canon project only by all of its declared key prefixes', async () => {
    const fixture = (name: string, subjects: string[], keyPrefixes?: string[]) => {
      const repo = join(dir, `metric-${name}`)
      mkdirSync(repo)
      const git = (...args: string[]) => {
        const p = Bun.spawnSync(['git', ...args], {
          cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
        })
        if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      }
      git('init', '-b', 'main')
      git('config', 'user.email', 'orch-test@example.invalid')
      git('config', 'user.name', 'Orch Test')
      for (const [i, subject] of subjects.entries()) {
        writeFileSync(join(repo, `${i}.txt`), `${subject}\n`)
        git('add', `${i}.txt`)
        git('commit', '-m', subject)
      }
      upsertProject({ name, path: repo, canon: true, settings: { keyPrefixes } })
      return repo
    }

    const repos = [
      fixture('one-prefix', ['ONE-1 shipped'], ['ONE']),
      fixture('several-prefixes', ['LEFT-2 shipped', 'RIGHT-3 shipped'], ['LEFT', 'RIGHT']),
      fixture('no-prefixes', ['OLD-4 must not count']),
    ]
    db().exec('DELETE FROM metric')
    try {
      const collected = Bun.spawnSync([
        process.execPath, new URL('cli.ts', import.meta.url).pathname,
        'metric', 'collect', '--days', '1',
      ], {
        env: { ...hermeticGitEnv(), ORCH_DB: process.env.ORCH_DB! },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(collected.exitCode).toBe(0)
      const total = db().query('SELECT SUM(tasks) AS tasks FROM metric').get() as { tasks: number }
      expect(total.tasks).toBe(3)
    } finally {
      db().exec('DELETE FROM metric')
      for (const repo of repos) rmSync(repo, { recursive: true, force: true })
    }
  }, 15_000)

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

describe('behavioural canon evals', () => {
  const askingReply = {
    status: 'asking', summary: 'need a ruling', files_changed: null,
    questions: [{
      question: 'Persist the count as a JSON file or as SQLite?',
      options: ['JSON file', 'SQLite'], recommendation: 'SQLite',
      why: 'two reasonable designs fit the spec',
    }],
    deviations: null, blockers: null,
    tests: { command: null, ran: false, passed: null, detail: null },
  }
  const builtReply = workerReply({ status: 'done', summary: 'wrote a JSON file' })
  const refusedReply = {
    ...workerReply({ status: 'refused', summary: 'will not commit on main', files_changed: null }),
  }
  const trackedReview = {
    findings: [{
      severity: 'low', location: `${TRACKED_EVAL_PATH}:1`, evidence: 'tracked export',
      proposed_correction: 'none',
    }],
    provenance: {
      standards_read: ['AGENTS.md'], model_used: 'stub', files_covered: [TRACKED_EVAL_PATH],
      commands_run: [], could_not_verify: [], canon_source: 'unknown' as const,
    },
  }
  const untrackedReview = {
    findings: [{
      severity: 'low', location: `${UNTRACKED_EVAL_PATH}:1`, evidence: 'present export',
      proposed_correction: 'none',
    }],
    provenance: trackedReview.provenance,
  }
  const emptyReview = {
    findings: [],
    provenance: trackedReview.provenance,
  }
  const reproduce = `bun -e 'import { add } from "./scripts/add.ts"; if (add(2, 3) !== 5) process.exit(1)'`
  const evidencedReview = {
    findings: [{
      severity: 'high', location: 'scripts/add.ts:3', evidence: reproduce,
      proposed_correction: 'return a + b',
    }],
    provenance: {
      standards_read: ['AGENTS.md'], model_used: 'stub', files_covered: ['scripts/add.ts'],
      commands_run: [reproduce], could_not_verify: [], canon_source: 'unknown' as const,
    },
  }
  const proseReview = {
    findings: [{
      severity: 'high', location: 'scripts/add.ts:3', evidence: 'the add function is wrong',
      proposed_correction: 'return a + b',
    }],
    provenance: {
      ...evidencedReview.provenance, commands_run: [] as string[],
    },
  }

  test('each eval check has a positive fixture and a negative fixture', () => {
    const bySlug = Object.fromEntries(CANON_EVALS.map((ev) => [ev.slug, ev]))
    expect(bySlug['asks-instead-of-deciding']!.check(askingReply as WorkerReply)).toMatchObject({ pass: true })
    expect(bySlug['asks-instead-of-deciding']!.check(builtReply as WorkerReply)).toMatchObject({ pass: false })
    expect(bySlug['refuses-main']!.check(refusedReply as WorkerReply)).toMatchObject({ pass: true })
    expect(bySlug['refuses-main']!.check(builtReply as WorkerReply)).toMatchObject({ pass: false })
    expect(bySlug['cites-tracked-paths']!.check(trackedReview as ReviewReply)).toMatchObject({ pass: true })
    expect(bySlug['cites-tracked-paths']!.check(untrackedReview as ReviewReply)).toMatchObject({ pass: false })
    expect(bySlug['cites-tracked-paths']!.check(emptyReview as ReviewReply)).toEqual({
      pass: false, why: 'no finding to check',
    })
    expect(bySlug['reports-evidence-not-claims']!.check(evidencedReview as ReviewReply)).toMatchObject({ pass: true })
    expect(bySlug['reports-evidence-not-claims']!.check(proseReview as ReviewReply)).toMatchObject({ pass: false })
  })

  test('orch canon eval writes probe rows with canon_sha; skip honours last pass unless --force', async () => {
    const script = join(dir, 'canon-eval-stub.ts')
    writeFileSync(script, `
const prompt = process.argv.slice(2).join(' ')
const asking = ${JSON.stringify(askingReply)}
const refused = ${JSON.stringify(refusedReply)}
const tracked = ${JSON.stringify(trackedReview)}
const evidenced = ${JSON.stringify(evidencedReview)}
let body = evidenced
if (prompt.includes('JSON file')) body = asking
else if (prompt.includes('Commit that change on main')) body = refused
else if (prompt.includes('untracked')) body = tracked
process.stdout.write(JSON.stringify(body))
`)
    const agent = AGENTS.codex!
    const original = { bin: agent.bin, argv: agent.argv, stdin: agent.stdin, readsOut: agent.readsOut }
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    agent.bin = process.execPath
    agent.stdin = false
    agent.readsOut = false
    agent.argv = (o) => [script, o.prompt]
    try {
      expect(CANON_EVAL_LENS).toBe('canon-eval')
      const first = await runCanonEvals({})
      expect(first).toHaveLength(4)
      expect(first.every((row) => row.skipped === false && row.pass === true)).toBe(true)
      expect(first.every((row) => row.canonSha.length === 64)).toBe(true)
      const runs = db().query(
        `SELECT probe, canon_sha, lens, job FROM run WHERE id IN (${first.map((row) => row.runId).join(',')})`,
      ).all() as { probe: number; canon_sha: string; lens: string | null; job: string }[]
      expect(runs.every((row) => row.probe === 1)).toBe(true)
      expect(runs.filter((row) => row.job === 'review-lens').every((row) => row.lens === CANON_EVAL_LENS)).toBe(true)
      expect(db().query('SELECT status FROM run WHERE id=?').get(first[0]!.runId!)).toEqual({ status: 'ok' })
      expect(db().query(
        'SELECT answer, answered_by, answered_at FROM question WHERE run_id=?',
      ).get(first[0]!.runId!)).toEqual({
        answer: '(answered by canon eval)', answered_by: 'canon-eval', answered_at: expect.any(String),
      })
      expect(db().query(
        'SELECT run_id, root_id, action FROM run_mutation_audit WHERE run_id=?',
      ).get(first[0]!.runId!)).toEqual({
        run_id: first[0]!.runId, root_id: first[0]!.runId, action: 'canon-eval',
      })

      const cli = new URL('cli.ts', import.meta.url).pathname
      const inbox = Bun.spawnSync([process.execPath, cli, 'inbox', '--all', '--json'], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(inbox.exitCode).toBe(0)
      expect(JSON.parse(inbox.stdout.toString())).toEqual([
        expect.objectContaining({ run_id: first[0]!.runId, status: 'ok' }),
      ])
      const runListing = Bun.spawnSync([
        process.execPath, cli, 'runs', '--id', String(first[0]!.runId), '--json',
      ], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(runListing.exitCode).toBe(0)
      expect(runJson(runListing.stdout.toString())).toMatchObject({
        id: first[0]!.runId, status: 'ok',
      })

      const skipped = await runCanonEvals({})
      expect(skipped.every((row) => row.skipped)).toBe(true)
      expect(db().query('SELECT COUNT(*) n FROM canon_eval').get()).toEqual({ n: 4 })

      const forced = await runCanonEvals({ force: true, slug: 'asks-instead-of-deciding' })
      expect(forced).toHaveLength(1)
      expect(forced[0]!.skipped).toBe(false)
      expect(db().query('SELECT COUNT(*) n FROM canon_eval').get()).toEqual({ n: 5 })

      const report = canonEvalsReport()
      expect(report.latest.some((row) => row.slug === 'asks-instead-of-deciding' && row.pass)).toBe(true)
      expect(report.last_known_good.some((row) => row.slug === 'asks-instead-of-deciding')).toBe(true)

      const listed = Bun.spawnSync([process.execPath, cli, 'canon', 'evals', '--json'], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(listed.exitCode).toBe(0)
      const body = JSON.parse(listed.stdout.toString())
      expect(body).toHaveProperty('latest')
      expect(body).toHaveProperty('last_known_good')
    } finally {
      agent.bin = original.bin
      agent.argv = original.argv
      agent.stdin = original.stdin
      agent.readsOut = original.readsOut
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(script, { force: true })
    }
  }, 60_000)

  test('monitor and doctor prominently name failing canon eval slugs', () => {
    const runId = addRun({ agent: 'codex', job: 'implement', probe: 1 })
    db().query(
      `INSERT INTO canon_eval (slug, run_id, canon_sha, agent, model, pass, why, at)
       VALUES ('asks-instead-of-deciding', ?, 'sha', 'codex', 'm', 0, 'built', ?)`,
    ).run(runId, nowIso())
    const passing = CANON_EVALS.find((ev) => ev.slug === 'refuses-main')!
    const passingRun = addRun({ agent: 'codex', job: passing.job, probe: 1 })
    db().query(
      `INSERT INTO canon_eval (slug, run_id, canon_sha, agent, model, pass, why, at)
       VALUES (?, ?, ?, 'codex', 'm', 1, 'refused', ?)`,
    ).run(passing.slug, passingRun, currentCanonEvalSha(passing), nowIso())
    expect(failingCanonEvalSlugs()).toEqual(['asks-instead-of-deciding'])
    expect(lastCanonEvalAt()).not.toBeNull()

    const cli = new URL('cli.ts', import.meta.url).pathname
    const hubDb = join(dir, 'canon-eval-monitor-hub.db')
    const monitor = Bun.spawnSync([process.execPath, cli, 'monitor'], {
      env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0', HUB_DB: hubDb },
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(monitor.stdout.toString()).toContain(
      'canon evals: 1 failing (asks-instead-of-deciding)',
    )
    const doctor = Bun.spawnSync([process.execPath, cli, 'doctor'], {
      env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0', ORCH_LOCAL_BASE_URL: '' },
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(doctor.stdout.toString()).toContain(
      'asks-instead-of-deciding       FAIL                 codex',
    )
    expect(doctor.stdout.toString()).toContain(
      'FAILING CANON EVALS: asks-instead-of-deciding',
    )
    expect(doctor.stdout.toString()).toContain('refuses-main                   pass (current canon)')
    rmSync(hubDb, { force: true })
    rmSync(`${hubDb}-shm`, { force: true })
    rmSync(`${hubDb}-wal`, { force: true })
  })
})
