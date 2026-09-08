import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AGENTS, addRun, candidates, classify, db, declaredCreate, dir, hermeticGitEnv,
  JOBS, NEEDS_HUMAN, NOT_EVIDENCE, run, upsertProject,
} from '../test/fixture.ts'
import { pidAlive } from './db.ts'
import { formatIdleKillError, idleKillMayProceed, idleKillMs, isGroupKillablePgid, isUninterruptible, isWorkerCpuIdle,
  parseIdleReclaimedMs, parsePsTable, shouldIdleKill, terminateProcessGroup,
  DEFAULT_EXTERNAL_WAIT_IDLE_KILL_MS, DEFAULT_IDLE_KILL_MS } from './idle-kill.ts'
import { EXTERNAL_WAIT_JOBS, jobIdleKillMs } from './jobs.ts'
import { isRoutingEvidence } from './route.ts'
import { harnessHealth } from './health.ts'
import { installTestTransport, type AgentTransport, type TransportResult } from './transport.ts'

const roots: string[] = []
afterEach(() => {
  installTestTransport(null)
  delete process.env.ORCH_IDLE_KILL_MS
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'orch-idle-'))
  roots.push(root)
  const g = (...args: string[]) => {
    const p = Bun.spawnSync(['git', ...args], { cwd: root, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' })
    if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    return p.stdout.toString().trim()
  }
  g('init', '-b', 'main')
  g('config', 'user.name', 'Test')
  g('config', 'user.email', 'test@example.com')
  writeFileSync(join(root, 'file.txt'), 'base\n')
  g('add', 'file.txt'); g('commit', '-m', 'DEV-389 base')
  return root
}

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(['git', ...args], { cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' })
  if (p.exitCode !== 0) throw new Error(p.stderr.toString())
  return p.stdout.toString().trim()
}

describe('idle kill threshold', () => {
  test('default is 15m, from the measured gap distribution, not a round number', () => {
    // 90 completed runs with events.jsonl, ids 2874–2997, 17815 gaps.
    // max succeeding gap 10.39m (run 2874); 15m is above every observed gap.
    expect(DEFAULT_IDLE_KILL_MS).toBe(15 * 60_000)
    expect(idleKillMs({})).toBe(15 * 60_000)
    expect(idleKillMs({ ORCH_IDLE_KILL_MS: '400' })).toBe(400)
  })

  test('jobs that wait outside the vendor tree get a longer idle bound', () => {
    expect(DEFAULT_EXTERNAL_WAIT_IDLE_KILL_MS).toBe(30 * 60_000)
    expect([...EXTERNAL_WAIT_JOBS]).toEqual([
      'implement', 'fix', 'issue-worker', 'land',
      'review-lens', 'safety', 'craft',
      'mcp-query',
      'file-question', 'summarize', 'canon-lookup',
    ])
    for (const name of EXTERNAL_WAIT_JOBS) {
      expect(jobIdleKillMs(name, {})).toBe(30 * 60_000)
    }
    expect(jobIdleKillMs('understand', {})).toBe(15 * 60_000)
    expect(jobIdleKillMs('diagnose', {})).toBe(15 * 60_000)
    expect(jobIdleKillMs('verify-claim', {})).toBe(15 * 60_000)
    expect(jobIdleKillMs('review-lens-inline', {})).toBe(15 * 60_000)
    expect(jobIdleKillMs('implement', { ORCH_IDLE_KILL_MS: '400' })).toBe(400)
    for (const name of Object.keys(JOBS)) {
      expect(jobIdleKillMs(name, {})).toBeGreaterThan(0)
    }
  })
})

describe('idle kill classification', () => {
  test('idle is its own kind, not evidence, and not a human page or cooldown', () => {
    expect(classify('idle-killed after 12m with no CPU; reclaimed 33m of 45m wall', 143)).toBe('idle')
    expect(classify('exit 143, empty output', 143, false, null, true)).toBe('idle')
    expect(NOT_EVIDENCE).toContain('idle')
    expect(NEEDS_HUMAN).not.toContain('idle')
    expect(isRoutingEvidence({ status: 'failed', delivery: null, failureKind: 'idle' })).toBe(false)
  })

  test('an idle-killed run is not routing evidence', () => {
    addRun({ agent: 'grok', job: 'implement', status: 'failed', kind: 'idle' })
    expect(candidates('implement').find((item) => item.agent === 'grok'))
      .toMatchObject({ failures: 0, evidence: 0, score: null })
  })
})

describe('checkpoint failure aborts the kill', () => {
  test('a failed final checkpoint with no prior does not proceed', () => {
    expect(idleKillMayProceed(null, false)).toBe(true)
    expect(idleKillMayProceed({ created: true, error: null }, false)).toBe(true)
    expect(idleKillMayProceed({ created: false, error: null }, false)).toBe(true)
    expect(idleKillMayProceed({ created: false, error: 'git status failed' }, true)).toBe(true)
    expect(idleKillMayProceed({ created: false, error: 'git status failed' }, false)).toBe(false)
  })
})

describe('silence and CPU', () => {
  const started = '2026-09-08T00:00:00.000Z'
  const last = '2026-09-08T00:01:00.000Z'
  const now = Date.parse('2026-09-08T00:16:00.000Z')
  const samples = parsePsTable('  10   1  10   0.0 S\n  11  10  10  80.0 R\n')

  test('silence past the threshold with no CPU is a kill', () => {
    expect(shouldIdleKill({
      lastEventAt: last, startedAt: started, pid: 10, asking: false, openQuestion: false,
      alreadyTimedOut: false, alreadyIdleKilled: false, now, thresholdMs: 5 * 60_000,
      samples: parsePsTable('  10   1  10   0.0 S\n'),
    })).toMatchObject({ kill: true })
  })

  test('a worker that is quiet but burning CPU is not killed', () => {
    expect(shouldIdleKill({
      lastEventAt: last, startedAt: started, pid: 10, asking: false, openQuestion: false,
      alreadyTimedOut: false, alreadyIdleKilled: false, now, thresholdMs: 5 * 60_000,
      samples,
    })).toMatchObject({ kill: false, reason: 'quiet but burning CPU' })
    expect(isWorkerCpuIdle(10, samples)).toBe(false)
  })

  test('an open question is not idle', () => {
    expect(shouldIdleKill({
      lastEventAt: last, startedAt: started, pid: 10, asking: true, openQuestion: false,
      alreadyTimedOut: false, alreadyIdleKilled: false, now, thresholdMs: 5 * 60_000,
      samples: parsePsTable('  10   1  10   0.0 S\n'),
    }).kill).toBe(false)
    expect(shouldIdleKill({
      lastEventAt: last, startedAt: started, pid: 10, asking: false, openQuestion: true,
      alreadyTimedOut: false, alreadyIdleKilled: false, now, thresholdMs: 5 * 60_000,
      samples: parsePsTable('  10   1  10   0.0 S\n'),
    }).kill).toBe(false)
  })

  test('an unobservable process table is not idle', () => {
    expect(shouldIdleKill({
      lastEventAt: last, startedAt: started, pid: 10, asking: false, openQuestion: false,
      alreadyTimedOut: false, alreadyIdleKilled: false, now, thresholdMs: 5 * 60_000,
      samples: [],
    })).toMatchObject({ kill: false, reason: 'process table unobservable' })
    expect(isWorkerCpuIdle(10, [])).toBe(false)
  })

  test('the wall owns the run once it has fired', () => {
    expect(shouldIdleKill({
      lastEventAt: last, startedAt: started, pid: 10, asking: false, openQuestion: false,
      alreadyTimedOut: true, alreadyIdleKilled: false, now, thresholdMs: 5 * 60_000,
      samples: parsePsTable('  10   1  10   0.0 S\n'),
    }).kill).toBe(false)
  })
})

describe('process group termination', () => {
  test('unknown selfPgid never group-kills; pgid 0 and 1 are rejected', async () => {
    expect(isGroupKillablePgid(50, null)).toBe(false)
    expect(isGroupKillablePgid(1, 50)).toBe(false)
    expect(isGroupKillablePgid(0, 50)).toBe(false)
    expect(isGroupKillablePgid(50, 50)).toBe(false)
    expect(isGroupKillablePgid(50, 1)).toBe(true)

    const groupSignals = (opts: {
      vendorPgid: number
      selfPgid: number | null
    }) => {
      const signals: Array<{ pid: number; signal: NodeJS.Signals | number }> = []
      return terminateProcessGroup(100, {
        graceMs: 5, killConfirmMs: 5,
        deps: {
          kill(pid, signal) { signals.push({ pid, signal }) },
          alive: () => false,
          sample: () => [{ pid: 100, ppid: 1, pgid: opts.vendorPgid, cpu: 0, state: 'S' }],
          selfPgid: () => opts.selfPgid,
          wait: async () => {},
        },
      }).then(() => signals)
    }

    const unknownSelf = await groupSignals({ vendorPgid: 50, selfPgid: null })
    expect(unknownSelf.some((row) => row.pid === -50)).toBe(false)
    expect(unknownSelf.some((row) => row.pid === 100)).toBe(true)

    const pgidOne = await groupSignals({ vendorPgid: 1, selfPgid: 50 })
    expect(pgidOne.some((row) => row.pid === -1)).toBe(false)
    expect(pgidOne.some((row) => row.pid === 100)).toBe(true)
  })

  test('SIGTERM then confirm, then SIGKILL; a process that will not die is bounded', async () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals | number }> = []
    let alive = true
    const waits: number[] = []
    const result = await terminateProcessGroup(42, {
      graceMs: 20, killConfirmMs: 20,
      deps: {
        kill(pid, signal) { signals.push({ pid, signal }) },
        alive: () => alive,
        sample: () => [{ pid: 42, ppid: 1, pgid: 42, cpu: 0, state: 'D' }],
        selfPgid: () => 1,
        wait: async (ms) => { waits.push(ms) },
      },
    })
    expect(result.exited).toBe(false)
    expect(result.unkillable).toBe(true)
    expect(result.reason).toContain('D-state')
    expect(result.reason).toContain('needs a human')
    expect(signals.some((row) => row.signal === 'SIGTERM')).toBe(true)
    expect(signals.some((row) => row.signal === 'SIGKILL')).toBe(true)
    expect(waits.length).toBeGreaterThan(0)
    expect(isUninterruptible('D')).toBe(true)
    expect(isUninterruptible('U')).toBe(true)
  })

  test('a wrapper that exits still SIGKILLs a surviving child, including after reparent', async () => {
    const alive = new Set([42, 43])
    const signals: Array<{ pid: number; signal: NodeJS.Signals | number }> = []
    const result = await terminateProcessGroup(42, {
      graceMs: 20, killConfirmMs: 20,
      deps: {
        kill(pid, signal) {
          signals.push({ pid, signal })
          if (signal === 'SIGTERM' && pid === 42) alive.delete(42)
          if (signal === 'SIGKILL' && pid === 43) alive.delete(43)
        },
        alive: (pid) => alive.has(pid),
        sample: () => {
          const rows: Array<{ pid: number; ppid: number; pgid: number; cpu: number; state: string }> = []
          if (alive.has(42)) rows.push({ pid: 42, ppid: 1, pgid: 42, cpu: 0, state: 'S' })
          if (alive.has(43)) rows.push({ pid: 43, ppid: alive.has(42) ? 42 : 1, pgid: 42, cpu: 0, state: 'S' })
          return rows
        },
        // Unknown coordinator pgid: walk descendants, never group-kill.
        selfPgid: () => null,
        wait: async () => {},
      },
    })
    expect(result.exited).toBe(true)
    expect(result.unkillable).toBe(false)
    expect(signals.some((row) => row.pid === 42 && row.signal === 'SIGTERM')).toBe(true)
    expect(signals.some((row) => row.pid === 43 && row.signal === 'SIGKILL')).toBe(true)
    expect(alive.has(43)).toBe(false)
  })

  test('a real sleeper is signalled and exits without looping', async () => {
    const child = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' })
    expect(child.pid).toBeGreaterThan(0)
    const result = await terminateProcessGroup(child.pid, { graceMs: 500, killConfirmMs: 500 })
    expect(result.unkillable).toBe(false)
    expect(result.exited).toBe(true)
    expect(await child.exited).not.toBe(null)
    expect(pidAlive(child.pid)).toBe(false)
  })
})

describe('reclaimed time', () => {
  test('error encodes reclaimed wall time and health sums it', () => {
    const error = formatIdleKillError({ idleMs: 12 * 60_000, reclaimedMs: 1_980_000, boundMs: 2_700_000 })
    expect(error).toContain('idle-killed')
    expect(parseIdleReclaimedMs(error)).toBe(1_980_000)
    const id = addRun({
      agent: 'grok', job: 'implement', status: 'failed', kind: 'idle',
      latency: 720_000, startedAt: '2026-09-07T10:00:00.000Z',
    })
    db().query('UPDATE run SET error=? WHERE id=?').run(error, id)
    const report = harnessHealth(14, db(), new Date('2026-09-08T12:00:00.000Z'))
    const idle = report.classes.find((row) => row.kind === 'idle')
    expect(idle).toMatchObject({ count: 1, reclaimedMs: 1_980_000, totalTimeMs: 720_000 })
  })
})

describe('live idle kill', () => {
  test('a silent idle worker is checkpointed and terminated; its commits survive', async () => {
    const main = repo()
    const createPath = join(main, 'create.cjs')
    writeFileSync(createPath, `const {spawnSync}=require('child_process');const {mkdirSync}=require('fs');` +
      `const {join}=require('path');const branch=process.argv.at(-1);const root=${JSON.stringify(main)};` +
      `const path=join(root,'trees',branch);mkdirSync(join(root,'trees'),{recursive:true});` +
      `const p=spawnSync('git',['worktree','add','-b',branch,path,'main'],{cwd:root,stdio:['ignore','ignore','inherit']});` +
      `if(p.status)process.exit(p.status);process.stdout.write(path+'\\n')`)
    upsertProject({ name: `idle-kill-commit`, path: main,
      settings: { trunk: 'main', worktree: {
        create: declaredCreate(process.execPath, [createPath, '{branch}']),
        branch: '{key}-orch-{id}',
      } } })
    const transport: AgentTransport = {
      name: 'cli',
      async start(opts) {
        const script = join(opts.cwd, 'idle-worker.sh')
        writeFileSync(script, `#!/bin/sh\nset -e\necho worker > worker.txt\ngit add worker.txt\n` +
          `git commit -m "DEV-389 worker commit" >/dev/null\necho dirty >> file.txt\nexec sleep 3600\n`)
        chmodSync(script, 0o755)
        const child = Bun.spawn([script], {
          cwd: opts.cwd, env: opts.env, stdout: 'ignore', stderr: 'ignore',
        })
        const empty: TransportResult = {
          stdout: '', stderr: '', raw: '', parsed: null, output: '', tokens: null, costUsd: null,
          sessionId: null, stopReason: null, error: null, exitCode: 143, pid: child.pid,
          events: [], asking: false, failureKind: null, status: 'failed', questions: [],
        }
        return {
          pid: child.pid, kill(sig) { try { child.kill(sig === 9 ? 9 : 'SIGTERM') } catch { /* gone */ } },
          async prompt() {}, async *events() {}, async cancel() { try { child.kill('SIGTERM') } catch { /* gone */ } },
          async collect() {
            empty.exitCode = await child.exited
            return empty
          },
        }
      },
      prompt(handle, text) { return handle.prompt(text) },
      events(handle) { return handle.events() },
      cancel(handle) { return handle.cancel() },
      resume(opts) { return this.start(opts) },
    }
    installTestTransport(transport)
    process.env.ORCH_IDLE_KILL_MS = '400'
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    let runId: number | null = null
    try {
      const result = await run({
        job: 'implement', prompt: 'edit the tracked file', cwd: main,
        agent: 'codex', key: 'DEV-389', noFailover: true,
      })
      runId = result.id
    } catch (error) {
      runId = (error as Error & { runId?: number }).runId ?? null
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
    expect(runId).not.toBeNull()
    const row = db().query(
      'SELECT failure_kind,work_preserved,worktree,branch,error,status FROM run WHERE id=?',
    ).get(runId) as {
      failure_kind: string; work_preserved: number; worktree: string; branch: string
      error: string; status: string
    }
    expect(row.status).toBe('failed')
    expect(row.failure_kind).toBe('idle')
    expect(row.error).toContain('idle-killed')
    expect(row.work_preserved).toBe(1)
    const subjects = git(row.worktree, 'log', '--format=%s', 'main..HEAD')
    expect(subjects).toContain('DEV-389 worker commit')
    expect(subjects).toContain(`DEV-389 checkpoint run ${runId} #1`)
    expect(isRoutingEvidence({ status: row.status, delivery: null, failureKind: row.failure_kind })).toBe(false)
    expect(candidates('implement').find((item) => item.agent === 'codex'))
      .toMatchObject({ failures: 0, evidence: 0 })
  }, 20_000)

  test('a failed checkpoint with no prior leaves the worker for the wall', async () => {
    const main = repo()
    const createPath = join(main, 'create.cjs')
    writeFileSync(createPath, `const {spawnSync}=require('child_process');const {mkdirSync}=require('fs');` +
      `const {join}=require('path');const branch=process.argv.at(-1);const root=${JSON.stringify(main)};` +
      `const path=join(root,'trees',branch);mkdirSync(join(root,'trees'),{recursive:true});` +
      `const p=spawnSync('git',['worktree','add','-b',branch,path,'main'],{cwd:root,stdio:['ignore','ignore','inherit']});` +
      `if(p.status)process.exit(p.status);process.stdout.write(path+'\\n')`)
    upsertProject({ name: `idle-kill-abort`, path: main,
      settings: { trunk: 'main', worktree: {
        create: declaredCreate(process.execPath, [createPath, '{branch}']),
        branch: '{key}-orch-{id}',
      } } })
    const transport: AgentTransport = {
      name: 'cli',
      async start(opts) {
        const script = join(opts.cwd, 'idle-worker.sh')
        writeFileSync(script, `#!/bin/sh\nset -e\necho worker > worker.txt\ngit add worker.txt\n` +
          `git commit -m "DEV-389 worker commit" >/dev/null\necho dirty >> file.txt\n` +
          `rm -rf .git\nsleep 2\n`)
        chmodSync(script, 0o755)
        const child = Bun.spawn([script], {
          cwd: opts.cwd, env: opts.env, stdout: 'ignore', stderr: 'ignore',
        })
        const empty: TransportResult = {
          stdout: '', stderr: '', raw: '', parsed: null, output: '', tokens: null, costUsd: null,
          sessionId: null, stopReason: null, error: null, exitCode: 0, pid: child.pid,
          events: [], asking: false, failureKind: null, status: 'failed', questions: [],
        }
        return {
          pid: child.pid, kill(sig) { try { child.kill(sig === 9 ? 9 : 'SIGTERM') } catch { /* gone */ } },
          async prompt() {}, async *events() {}, async cancel() { try { child.kill('SIGTERM') } catch { /* gone */ } },
          async collect() {
            empty.exitCode = await child.exited
            return empty
          },
        }
      },
      prompt(handle, text) { return handle.prompt(text) },
      events(handle) { return handle.events() },
      cancel(handle) { return handle.cancel() },
      resume(opts) { return this.start(opts) },
    }
    installTestTransport(transport)
    process.env.ORCH_IDLE_KILL_MS = '400'
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    let runId: number | null = null
    try {
      try {
        const result = await run({
          job: 'implement', prompt: 'edit the tracked file', cwd: main,
          agent: 'codex', key: 'DEV-389', noFailover: true,
        })
        runId = result.id
      } catch (error) {
        runId = (error as Error & { runId?: number }).runId ?? null
      }
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
    expect(runId).not.toBeNull()
    const row = db().query('SELECT failure_kind,error,status FROM run WHERE id=?').get(runId) as {
      failure_kind: string | null; error: string | null; status: string
    }
    expect(row.failure_kind).not.toBe('idle')
    expect(row.error ?? '').not.toContain('idle-killed')
  }, 15_000)

  test('a quiet CPU-burning worker is not idle-killed; the wall still fires independently', async () => {
    const grok = AGENTS.grok!
    const previousBin = grok.bin
    const previousTimeout = grok.timeoutMs
    const script = join(dir, 'cpu-burn.sh')
    writeFileSync(script, '#!/usr/bin/env python3\nwhile True:\n    pass\n')
    chmodSync(script, 0o755)
    process.env.ORCH_IDLE_KILL_MS = '400'
    process.env.ORCH_DEPTH = '0'
    try {
      grok.bin = script
      grok.timeoutMs = 2_500
      let runId: number | null = null
      try {
        const result = await run({
          job: 'summarize', prompt: 'hello', cwd: dir, agent: 'grok', noFailover: true,
        })
        runId = result.id
      } catch (error) {
        runId = (error as Error & { runId?: number }).runId ?? null
      }
      expect(runId).not.toBeNull()
      const row = db().query('SELECT failure_kind,status,error FROM run WHERE id=?').get(runId) as {
        failure_kind: string | null; status: string; error: string | null
      }
      expect(row.failure_kind).toBe('timeout')
      expect(row.status).toBe('failed')
      expect(row.error).not.toContain('idle-killed')
    } finally {
      grok.bin = previousBin
      grok.timeoutMs = previousTimeout
      delete process.env.ORCH_DEPTH
    }
  }, 15_000)

  test('a silent sleeper is idle-killed before the wall', async () => {
    const grok = AGENTS.grok!
    const previousBin = grok.bin
    const previousTimeout = grok.timeoutMs
    const script = join(dir, 'idle-sleep.sh')
    writeFileSync(script, '#!/bin/sh\nexec sleep 3600\n')
    chmodSync(script, 0o755)
    process.env.ORCH_IDLE_KILL_MS = '400'
    process.env.ORCH_DEPTH = '0'
    try {
      grok.bin = script
      grok.timeoutMs = 20_000
      let runId: number | null = null
      try {
        const result = await run({
          job: 'summarize', prompt: 'hello', cwd: dir, agent: 'grok', noFailover: true,
        })
        runId = result.id
      } catch (error) {
        runId = (error as Error & { runId?: number }).runId ?? null
      }
      expect(runId).not.toBeNull()
      const row = db().query('SELECT failure_kind,status,error FROM run WHERE id=?').get(runId) as {
        failure_kind: string | null; status: string; error: string | null
      }
      expect(row.failure_kind).toBe('idle')
      expect(row.status).toBe('failed')
      expect(row.error).toContain('idle-killed')
      expect(row.error).toContain('reclaimed_ms=')
      const reclaimed = parseIdleReclaimedMs(row.error)
      expect(reclaimed).toBeGreaterThan(15_000)
      expect(reclaimed).toBeLessThanOrEqual(20_000)
      expect(isRoutingEvidence({ status: row.status, delivery: null, failureKind: row.failure_kind })).toBe(false)
    } finally {
      grok.bin = previousBin
      grok.timeoutMs = previousTimeout
      delete process.env.ORCH_DEPTH
    }
  }, 15_000)

  test('an ACP idle kill is recorded as idle, not the transport timeout, and is not evidence', async () => {
    const transport: AgentTransport = {
      name: 'acp',
      async start() {
        const child = Bun.spawn(['sleep', '3600'], { stdout: 'ignore', stderr: 'ignore' })
        let cancelled = false
        return {
          pid: child.pid, kill(sig) { try { child.kill(sig === 9 ? 9 : 'SIGTERM') } catch { /* gone */ } },
          async prompt() {}, async *events() {},
          async cancel() { cancelled = true; try { child.kill('SIGTERM') } catch { /* gone */ } },
          async collect() {
            await child.exited
            return {
              stdout: '', stderr: '', raw: '', parsed: null, output: '',
              tokens: null, costUsd: null, sessionId: 'acp-idle',
              stopReason: cancelled ? 'timeout' : 'end_turn',
              error: cancelled ? 'no reply within the run bound; the agent was killed' : null,
              exitCode: 143, pid: child.pid, events: [], asking: false,
              failureKind: cancelled ? 'timeout' : null,
              status: 'failed', questions: [],
            }
          },
        }
      },
      prompt(handle, text) { return handle.prompt(text) },
      events(handle) { return handle.events() },
      cancel(handle) { return handle.cancel() },
      resume(opts) { return this.start(opts) },
    }
    installTestTransport(transport)
    process.env.ORCH_IDLE_KILL_MS = '400'
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    let runId: number | null = null
    try {
      try {
        const result = await run({
          job: 'summarize', prompt: 'hello', cwd: dir, agent: 'grok',
          transport: 'acp', noFailover: true,
        })
        runId = result.id
      } catch (error) {
        runId = (error as Error & { runId?: number }).runId ?? null
      }
      expect(runId).not.toBeNull()
      const row = db().query('SELECT failure_kind,status,error FROM run WHERE id=?').get(runId) as {
        failure_kind: string | null; status: string; error: string | null
      }
      expect(row.failure_kind).toBe('idle')
      expect(row.status).toBe('failed')
      expect(row.error).toContain('idle-killed')
      expect(row.error).not.toContain('no reply within the run bound')
      expect(isRoutingEvidence({ status: row.status, delivery: null, failureKind: row.failure_kind })).toBe(false)
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  }, 15_000)
})
