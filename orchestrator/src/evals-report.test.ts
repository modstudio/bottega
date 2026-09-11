import { describe,expect,test } from 'bun:test'
import { mkdirSync,rmSync,writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CANON_EVALS,TRACKED_EVAL_PATH,UNTRACKED_EVAL_PATH,addRun,currentCanonEvalSha,db,dir,failingCanonEvalSlugs,hermeticGitEnv,lastCanonEvalAt,nowIso,upsertProject,workerReply } from '../test/fixture.ts'
import type { ReviewReply,WorkerReply } from './contract.ts'
import { collect } from './metric.ts'

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
      await collect(1)
      const total = db().query('SELECT SUM(tasks) AS tasks FROM metric').get() as { tasks: number }
      expect(total.tasks).toBe(3)
    } finally {
      db().exec('DELETE FROM metric')
      for (const repo of repos) rmSync(repo, { recursive: true, force: true })
    }
  }, 15_000)
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
      commands_run: [], mcp_tools: [], docs_read: [], could_not_verify: [], substitutes: [], canon_source: 'unknown' as const,
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
      commands_run: [reproduce], mcp_tools: [], docs_read: [], could_not_verify: [], substitutes: [], canon_source: 'unknown' as const,
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

  })
})
