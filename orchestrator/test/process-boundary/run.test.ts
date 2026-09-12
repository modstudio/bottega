import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AGENTS, addRun, ask, candidates, db, dir, hermeticGitEnv, reapTestRun, reviewReply, run, score, upsertProject, weigh, runJob } from "../fixture.ts"
import { stubWorker } from "../stub-worker.ts"
import { installTestTransport } from "../../src/transport.ts"
import { trackedTestResidue } from '../residue.ts'
const trackResidue = trackedTestResidue()
let priorOrchDepth: string | undefined
beforeEach(() => { priorOrchDepth = process.env.ORCH_DEPTH; trackResidue(join(dir, '.claude')) })
afterEach(() => {
  installTestTransport(null)
  if (priorOrchDepth === undefined) delete process.env.ORCH_DEPTH
  else process.env.ORCH_DEPTH = priorOrchDepth
})

// These assertions cross a real child, timeout, or live ask boundary.
describe('run process boundary', () => {
  test('after a run, pid is the worker pid and agent_pid is the agent\'s', async () => {
    const pidFile = trackResidue(join(dir, 'fake-agent.pid'))
    const script = stubWorker()
    const grok = AGENTS.grok!
    const previous = grok.bin
    const priorDepth = process.env.ORCH_DEPTH
    const priorPidFile = process.env.ORCH_STUB_PID_FILE
    const priorOutput = process.env.ORCH_STUB_OUTPUT
    process.env.ORCH_DEPTH = '0'
    process.env.ORCH_STUB_PID_FILE = pidFile
    process.env.ORCH_STUB_OUTPUT = 'a valid reply'
    try {
      grok.bin = script
      const reserved = addRun({ agent: '(pending)', job: 'file-question', status: 'running' })
      db().query('UPDATE run SET pid=? WHERE id=?').run(process.pid, reserved)
      await run({ job: 'file-question', prompt: 'hello', cwd: dir, agent: 'grok', reserveId: reserved })
      const row = db().query('SELECT pid, agent_pid, agent_pgid, agent_start_time FROM run WHERE id=?')
        .get(reserved) as {
          pid: number; agent_pid: number; agent_pgid: number | null; agent_start_time: string | null
        }; expect(row.pid).toBe(process.pid); expect(row.agent_pid).toBe(Number(readFileSync(pidFile, 'utf8').trim())); expect(row.agent_pgid).toBeGreaterThan(1); expect(row.agent_start_time).toMatch(
        /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) /,
      )
    } finally {
      grok.bin = previous
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      if (priorPidFile === undefined) delete process.env.ORCH_STUB_PID_FILE
      else process.env.ORCH_STUB_PID_FILE = priorPidFile
      if (priorOutput === undefined) delete process.env.ORCH_STUB_OUTPUT
      else process.env.ORCH_STUB_OUTPUT = priorOutput
    }
  })

  test('a wall kill with no output remains a timeout and negative routing evidence', async () => {
    const script = stubWorker({ sleepSeconds: 3_600 })
    const grok = AGENTS.grok!
    const previousBin = grok.bin
    const previousTimeout = grok.timeoutMs
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    let runId: number | null = null
    try {
      grok.bin = script
      grok.timeoutMs = 250
      try {
        await run({
          job: 'file-question', prompt: 'where is the implementation?', cwd: dir,
          agent: 'grok', noFailover: true,
        })
      } catch (error) {
        runId = (error as Error & { runId?: number }).runId ?? null
      }; expect(runId).not.toBeNull(); expect(db().query(
        'SELECT status, failure_kind, exit_code, output_bytes FROM run WHERE id=?',
      ).get(runId!)).toMatchObject({
        status: 'failed', failure_kind: 'timeout', exit_code: 143, output_bytes: 0,
      }); expect(candidates('file-question').find((entry) => entry.agent === 'grok'))
        .toMatchObject({ runs: 0, scored: 0, failures: 1, evidence: 1,
          score: weigh('none', null) })
    } finally {
      grok.bin = previousBin
      grok.timeoutMs = previousTimeout
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      await reapTestRun(runId)
    }
  })

  test('a ruling that lands is handed straight back', async () => {
    const run = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    const stale = '2026-09-08T00:01:00.000Z'
    db().query('UPDATE run SET last_event_at=?, started_at=? WHERE id=?').run(stale, stale, run)
    const pending = ask({ runId: run, question: 'one table or two?', timeoutMs: 10_000 })
    for (let i = 0; i < 50; i++) {
      const q = db().query('SELECT id FROM question WHERE run_id = ?').get(run) as { id: number } | null
      if (q) {
        db().query("UPDATE question SET answer=?, answered_at=?, answered_by='t' WHERE id=?")
          .run('two', new Date().toISOString(), q.id)
        break
      }
      await new Promise((r) => setTimeout(r, 20))
    }; expect(await pending).toEqual({ answered: true, answer: 'two' })
    const row = db().query('SELECT last_event_at, status FROM run WHERE id=?').get(run) as {
      last_event_at: string; status: string
    }; expect(row.status).toBe('running'); expect(Date.parse(row.last_event_at)).toBeGreaterThan(Date.parse(stale))
  })

  test('a question nobody answers falls back rather than hanging', async () => {
    const run = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    const r = await ask({ runId: run, question: 'nobody is listening', timeoutMs: 50 }); expect(r.answered).toBe(false)
    if (!r.answered) expect(r.reason).toContain('blocked')
  })

})

describe('issue blast-radius review tree', () => {
test('a carried review launched from the fix worktree receives the committed fix tree', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-issue-review-tree-'))
    const fixTree = mkdtempSync(join(tmpdir(), 'orch-issue-fix-tree-'))
    const script = stubWorker()
    const agent = AGENTS.codex!
    const original = {
      bin: agent.bin, argv: agent.argv, stdin: agent.stdin,
      readsOut: agent.readsOut, parseReply: agent.parseReply,
    }
    const oldDepth = process.env.ORCH_DEPTH
    const oldOutput = process.env.ORCH_STUB_OUTPUT
    const runGit = (cwd: string, ...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    try {
      runGit(repo, 'init', '-b', 'main')
      runGit(repo, 'config', 'user.email', 'orch-test@example.invalid')
      runGit(repo, 'config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, 'reviewed.txt'), 'trunk\n')
      runGit(repo, 'add', 'reviewed.txt')
      runGit(repo, 'commit', '-m', 'DEV-261 fixture trunk')
      const trunkHead = runGit(repo, 'rev-parse', 'HEAD')
      runGit(repo, 'worktree', 'add', '-b', 'DEV-261-fix', fixTree)
      writeFileSync(join(fixTree, 'reviewed.txt'), 'fix\n')
      runGit(fixTree, 'add', 'reviewed.txt')
      runGit(fixTree, 'commit', '-m', 'DEV-261 fixture fix')
      const fixHead = runGit(fixTree, 'rev-parse', 'HEAD')
      upsertProject({ name: 'issue-project-tree', path: repo, settings: { trunk: 'main' } })
      upsertProject({ name: 'issue-fix-tree', path: fixTree, settings: { trunk: 'main' } })
      agent.bin = script
      agent.argv = () => []
      agent.stdin = true
      agent.readsOut = false
      agent.parseReply = undefined
      process.env.ORCH_DEPTH = '0'
      const provenance = (tree: string) => ({ tree_inspected: tree, standards_read: ['AGENTS.md'], model_used: 'fixture', files_covered: ['reviewed.txt'], commands_run: ['git rev-parse HEAD', 'git diff HEAD -- reviewed.txt'], mcp_tools: [], docs_read: [], could_not_verify: [], substitutes: [], canon_source: 'unknown' })
      process.env.ORCH_STUB_OUTPUT = JSON.stringify({
        findings: [{ severity: 'major', location: 'reviewed.txt:1', evidence: JSON.stringify({ head: trunkHead, diff: '' }), proposed_correction: 'fixture correction' }],
        provenance: provenance(trunkHead),
      })

      const fromProject = await runJob({
        job: 'review-lens', prompt: 'inspect the fix', cwd: repo,
        agent: 'codex', lens: 'issue-blast-radius', key: 'DEV-261',
      })
      process.env.ORCH_STUB_OUTPUT = JSON.stringify({ findings: [], provenance: provenance(fixHead) })
      const review = await runJob({
        job: 'review-lens', prompt: 'inspect the fix', cwd: fixTree,
        agent: 'codex', lens: 'issue-blast-radius', key: 'DEV-261',
        review: 'DEV-261-fix', carry: true,
      })
      const projectReply = JSON.parse(fromProject.output) as { findings: Array<{ evidence: string }> }
      const reviewReply = JSON.parse(review.output) as {
        findings: Array<{ evidence: string }>; provenance: { files_covered: string[] }
      }
      const projectReceived = JSON.parse(projectReply.findings[0]!.evidence) as { head: string; diff: string }
      expect(projectReceived).toEqual({ head: trunkHead, diff: '' })
      expect(review.status).toBe('ok')
      expect(reviewReply.findings).toEqual([])
      expect(reviewReply.provenance.files_covered).toContain('reviewed.txt')
      const runRow = db().query('SELECT head_commit, changed_paths FROM run WHERE id=?').get(review.id) as {
        head_commit: string; changed_paths: string
      }
      expect(runRow.head_commit).toBe(fixHead)
      expect(JSON.parse(runRow.changed_paths)).toContain('reviewed.txt')
      const stored = db().query(
        `SELECT review.path_set FROM review
           JOIN review_lens ON review_lens.review_id=review.id
          WHERE review_lens.run_id=?`,
      ).get(review.id) as { path_set: string }
      expect(JSON.parse(stored.path_set)).toContain('reviewed.txt')
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
      rmSync(fixTree, { recursive: true, force: true })
    }
  })

})
