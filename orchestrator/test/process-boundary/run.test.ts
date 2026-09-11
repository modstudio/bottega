import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync, existsSync, chmodSync, mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENTS, GENERIC_QUESTION_TOKENS, addDoctrineRule, addPair, addRun, addSkip, ask, baselineForPair, candidates, db, declaredCreate, detectBlockers, dir, hasRealQuestions, hermeticGitEnv, ledgerRef, listDoctrineRules, listLedgerRefs, listPairs, listSkips, nowIso, parseWorkerReply, parseWorkerReplyWithCount, pick, projects, realQuestions, reapTestRun, removeProject, resolveLedgerRef, retireDoctrineRule, reviewReply, run, stubWorker, runDetail, score, setBaseline, setLedgerRef, state, upsertProject, weigh, workerReply } from '../fixture.ts'
import { scriptedTransport, scriptedTransportSequence } from '../fake-transport.ts'
import { installTestTransport } from '../../src/transport.ts'
import { collectResult } from '../../src/collect.ts'
let priorOrchDepth: string | undefined
beforeEach(() => { priorOrchDepth = process.env.ORCH_DEPTH })
afterEach(() => {
  installTestTransport(null)
  if (priorOrchDepth === undefined) delete process.env.ORCH_DEPTH
  else process.env.ORCH_DEPTH = priorOrchDepth
})

// These assertions cross a real child, timeout, or live ask boundary.
describe('run process boundary', () => {
  test('after a run, pid is the worker pid and agent_pid is the agent\'s', async () => {
    const pidFile = join(dir, 'fake-agent.pid')
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
