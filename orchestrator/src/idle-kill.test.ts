import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AGENTS, addRun, candidates, classify, db, declaredCreate, dir, hermeticGitEnv, JOBS, NEEDS_HUMAN, NOT_EVIDENCE, reapTestProcess, reapTestRun, run, upsertProject, } from '../test/fixture.ts'
import { pidAlive } from './process-liveness.ts'
import { formatIdleKillError, idleKillMayProceed, idleKillMs, installTestProcessSampler, isGroupKillablePgid, isUninterruptible, isWorkerCpuIdle,
  parseIdleReclaimedMs, parsePsTable, runHasLiveDescendants, shouldIdleKill, terminateProcessGroup,
  DEFAULT_EXTERNAL_WAIT_IDLE_KILL_MS, DEFAULT_IDLE_KILL_MS } from './idle-kill.ts'
import { PRESERVATION_FAILED_FILE } from './checkpoint.ts'
import { CPU_LOCAL_JOBS, IDLE_BELOW_WALL_MS, JOB_TIMEOUTS, jobDeclaredWallMs, jobIdleKillMs } from './jobs.ts'
import { runScratchDir } from './run-artifacts.ts'
import { isRoutingEvidence } from './route.ts'
import { harnessHealth } from './health.ts'
import { installTestTransport, type AgentTransport, type TransportResult } from './transport.ts'

const roots: string[] = []
afterEach(() => {
  installTestTransport(null)
  installTestProcessSampler(null)
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

function expectOwnProcessGroup(pid: number): void {
  const deadline = Date.now() + 1_000
  let runnerPgid: number | null = null
  let childPgid: number | null = null
  while (Date.now() < deadline && (runnerPgid === null || childPgid === null)) {
    const table = Bun.spawnSync(['ps', '-axo', 'pid=,ppid=,pgid=,%cpu=,state='])
    expect(table.exitCode).toBe(0)
    const samples = parsePsTable(table.stdout.toString())
    runnerPgid = samples.find((row) => row.pid === process.pid)?.pgid ?? null
    childPgid = samples.find((row) => row.pid === pid)?.pgid ?? null
    if (runnerPgid === null || childPgid === null) Bun.sleepSync(10)
  }
  expect(runnerPgid).not.toBeNull()
  expect(childPgid).not.toBeNull()
  expect(childPgid).not.toBe(runnerPgid)
}

describe('idle kill threshold', () => {
  test('default is 15m, from the measured gap distribution, not a round number', () => {
    // 90 completed runs with events.jsonl, ids 2874–2997, 17815 gaps.
    // max succeeding gap 10.39m (run 2874); 15m is above every observed gap.
    expect(DEFAULT_IDLE_KILL_MS).toBe(15 * 60_000)
    expect(idleKillMs({})).toBe(15 * 60_000)
    expect(idleKillMs({ ORCH_IDLE_KILL_MS: '400' })).toBe(400)
  })

  test('the long idle bound is the default; only CPU-local jobs may use the short one', () => {
    expect(DEFAULT_EXTERNAL_WAIT_IDLE_KILL_MS).toBe(30 * 60_000)
    expect([...CPU_LOCAL_JOBS]).toEqual([])
    expect(jobIdleKillMs('understand', {})).toBe(30 * 60_000)
    expect(jobIdleKillMs('diagnose', {})).toBe(30 * 60_000)
    expect(jobIdleKillMs('implement', {})).toBe(30 * 60_000)
    expect(jobIdleKillMs('implement', { ORCH_IDLE_KILL_MS: '400' })).toBe(400)
    for (const name of Object.keys(JOB_TIMEOUTS)) {
      expect(jobIdleKillMs(name, {})).toBeGreaterThan(0)
    }
  })

  test('idle is strictly below the wall for every job', () => {
    expect(IDLE_BELOW_WALL_MS).toBe(60_000)
    for (const name of Object.keys(JOBS)) {
      const wall = jobDeclaredWallMs(name)
      expect(wall).toBeGreaterThan(0)
      const idle = jobIdleKillMs(name, {})
      expect(idle).toBeLessThan(wall!)
      expect(jobIdleKillMs(name, {}, wall!)).toBeLessThan(wall!)
    }
    expect(jobIdleKillMs('fix', {})).toBe(30 * 60_000 - IDLE_BELOW_WALL_MS)
    expect(jobIdleKillMs('review-lens', {})).toBe(30 * 60_000 - IDLE_BELOW_WALL_MS)
    expect(jobIdleKillMs('safety', {})).toBe(30 * 60_000 - IDLE_BELOW_WALL_MS)
    expect(jobIdleKillMs('craft', {})).toBe(30 * 60_000 - IDLE_BELOW_WALL_MS)
    expect(jobIdleKillMs('summarize', {})).toBe(20 * 60_000 - IDLE_BELOW_WALL_MS)
    expect(jobIdleKillMs('verify-claim', {})).toBe(20 * 60_000 - IDLE_BELOW_WALL_MS)
    expect(jobIdleKillMs('review-lens-inline', {})).toBe(20 * 60_000 - IDLE_BELOW_WALL_MS)
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

  test('the calling process is not a vendor tree', async () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals | number }> = []
    const result = await terminateProcessGroup(process.pid, {
      graceMs: 5, killConfirmMs: 5,
      deps: {
        kill(pid, signal) { signals.push({ pid, signal }) },
        alive: () => true,
        sample: () => [{ pid: process.pid, ppid: 1, pgid: process.pid, cpu: 0, state: 'S' }],
        selfPgid: () => process.pid,
        wait: async () => {},
      },
    })
    expect(result).toEqual({ exited: true, unkillable: false, reason: null, pgid: null, pids: [] })
    expect(signals).toEqual([])
  })

  test("the caller's own process group is refused from group kill and survivor tracking", async () => {
    const alive = new Set([100, 999])
    const signals: Array<{ pid: number; signal: NodeJS.Signals | number }> = []
    await terminateProcessGroup(100, {
      graceMs: 5, killConfirmMs: 5,
      deps: {
        kill(pid, signal) {
          signals.push({ pid, signal })
          if (pid === 100) alive.delete(100)
        },
        alive: (pid) => alive.has(pid),
        sample: () => [
          { pid: 100, ppid: 1, pgid: 50, cpu: 0, state: 'S' },
          { pid: 999, ppid: 1, pgid: 50, cpu: 0, state: 'S' },
        ],
        selfPgid: () => 50,
        wait: async () => {},
      },
    })
    expect(signals.some((row) => row.pid === -50)).toBe(false)
    expect(signals.some((row) => row.pid === 999)).toBe(false)
    expect(signals.some((row) => row.pid === 100 && row.signal === 'SIGTERM')).toBe(true)
  })



  test('live descendants, including tracked reparented pids, block reclaim', () => {
    const samples = parsePsTable('  10   1  10   0.0 S\n  11  10  10   0.0 S\n')
    expect(runHasLiveDescendants([10], [], {
      sample: () => samples, alive: (pid) => pid === 11,
    })).toBe(true)
    expect(runHasLiveDescendants([10], [], {
      sample: () => samples, alive: () => false,
    })).toBe(false)
    expect(runHasLiveDescendants([10], [99], {
      sample: () => [], alive: (pid) => pid === 99,
    })).toBe(true)
    expect(runHasLiveDescendants([null, 0], [], {
      sample: () => samples, alive: () => true,
    })).toBe(false)
  })


  test('reclaim re-samples; a late reparented child blocks via pgid', () => {
    const late = [{ pid: 99, ppid: 1, pgid: 10, cpu: 0, state: 'S' }]
    expect(runHasLiveDescendants([10], [10], {
      sample: () => late, alive: (pid) => pid === 99,
    }, 10)).toBe(true)
    expect(runHasLiveDescendants([10], [10], {
      sample: () => late, alive: (pid) => pid === 99,
    })).toBe(false)
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

  test('a completed reply.json outranks an idle kill', async () => {
    const main = repo()
    const createPath = join(main, 'create.cjs')
    writeFileSync(createPath, `const {spawnSync}=require('child_process');const {mkdirSync}=require('fs');` +
      `const {join}=require('path');const branch=process.argv.at(-1);const root=${JSON.stringify(main)};` +
      `const path=join(root,'trees',branch);mkdirSync(join(root,'trees'),{recursive:true});` +
      `const p=spawnSync('git',['worktree','add','-b',branch,path,'main'],{cwd:root,stdio:['ignore','ignore','inherit']});` +
      `if(p.status)process.exit(p.status);process.stdout.write(path+'\\n')`)
    upsertProject({ name: `idle-kill-reply`, path: main,
      settings: { trunk: 'main', worktree: {
        create: declaredCreate(process.execPath, [createPath, '{branch}']),
        branch: '{key}-orch-{id}',
      } } })
    const reply = JSON.stringify({
      status: 'done',
      summary: 'already finished',
      files_changed: ['file.txt'],
      questions: null,
      deviations: null,
      tests: { command: 'true', ran: true, passed: true, detail: null },
      blockers: null,
    })
    const transport: AgentTransport = {
      name: 'cli',
      async start(opts) {
        const script = join(opts.cwd, 'idle-worker.sh')
        writeFileSync(script, `#!/bin/sh\nset -e\necho worker > worker.txt\ngit add worker.txt\n` +
          `git commit -m "DEV-389 worker commit" >/dev/null\n` +
          `printf '%s\\n' ${JSON.stringify(reply)} > "$ORCH_SCRATCH/reply.json"\nexec sleep 3600\n`)
        chmodSync(script, 0o755)
        const child = Bun.spawn([script], {
          cwd: opts.cwd, env: opts.env, detached: true, stdout: 'ignore', stderr: 'ignore',
        })
        expectOwnProcessGroup(child.pid)
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
    installTestProcessSampler(() => {
      const rows = db().query(
        'SELECT agent_pid FROM run WHERE agent_pid IS NOT NULL',
      ).all() as { agent_pid: number }[]
      return rows.filter((row) => row.agent_pid > 1).map((row) => ({
        pid: row.agent_pid, ppid: 1, pgid: row.agent_pid, cpu: 0, state: 'S',
      }))
    })
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
    try {
    expect(runId).not.toBeNull()
    const row = db().query('SELECT failure_kind,status,error FROM run WHERE id=?').get(runId) as {
      failure_kind: string | null; status: string; error: string | null
    }
    expect(row.status).toBe('ok')
    expect(row.failure_kind).toBeNull()
    expect(row.error ?? '').not.toContain('idle-killed')
    } finally {
      await reapTestRun(runId)
    }
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
          `chmod 000 .git\necho gone > .idle-git-gone\nexec sleep 3600\n`)
        chmodSync(script, 0o755)
        const child = Bun.spawn([script], {
          cwd: opts.cwd, env: opts.env, detached: true, stdout: 'ignore', stderr: 'ignore',
        })
        expectOwnProcessGroup(child.pid)
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
    installTestProcessSampler(() => {
      const rows = db().query(
        'SELECT agent_pid, worktree FROM run WHERE agent_pid IS NOT NULL',
      ).all() as { agent_pid: number; worktree: string | null }[]
      return rows.flatMap((row) => {
        if (row.agent_pid <= 1) return []
        // Stay unobservable until the worker has made git unreadable so the
        // checkpoint fails rather than racing a successful commit.
        if (!row.worktree || !existsSync(join(row.worktree, '.idle-git-gone'))) return []
        return [{ pid: row.agent_pid, ppid: 1, pgid: row.agent_pid, cpu: 0, state: 'S' }]
      })
    })
    process.env.ORCH_IDLE_KILL_MS = '400'
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    let runId: number | null = null
    let vendorPid: number | null = null
    const pending = run({
      job: 'implement', prompt: 'edit the tracked file', cwd: main,
      agent: 'codex', key: 'DEV-389', noFailover: true, keepTree: true,
    }).then((result) => {
      runId = result.id
      return result
    }).catch((error: Error & { runId?: number }) => {
      runId = error.runId ?? runId
    })
    try {
      const deadline = Date.now() + 12_000
      while (Date.now() < deadline) {
        const row = db().query(
          'SELECT id, agent_pid FROM run WHERE agent_pid IS NOT NULL ORDER BY id DESC LIMIT 1',
        ).get() as { id: number; agent_pid: number } | null
        if (row) {
          runId = row.id
          vendorPid = row.agent_pid
          if (existsSync(join(runScratchDir(row.id), PRESERVATION_FAILED_FILE))) break
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      expect(runId).not.toBeNull()
      const notePath = join(runScratchDir(runId!), PRESERVATION_FAILED_FILE)
      expect(existsSync(notePath)).toBe(true)
      expect(vendorPid).not.toBeNull()
      expect(pidAlive(vendorPid!)).toBe(true)
      const note = JSON.parse(readFileSync(notePath, 'utf8')) as {
        preservation_failed: boolean; error: string
      }
      expect(note.preservation_failed).toBe(true)
      expect(note.error.length).toBeGreaterThan(0)
      expect(existsSync(join(runScratchDir(runId!), '..', 'preservation', PRESERVATION_FAILED_FILE))).toBe(true)
    } finally {
      if (runId) {
        const tree = db().query('SELECT worktree FROM run WHERE id=?').get(runId) as
          { worktree: string | null } | null
        if (tree?.worktree) {
          try { chmodSync(join(tree.worktree, '.git'), 0o644) } catch { /* already gone */ }
        }
      }
      await reapTestProcess(vendorPid)
      try { await pending } catch { /* the worker is standing down for the wall */ }
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
    expect(runId).not.toBeNull()
    const row = db().query('SELECT failure_kind,error,status FROM run WHERE id=?').get(runId) as {
      failure_kind: string | null; error: string | null; status: string
    }
    expect(row.failure_kind).not.toBe('idle')
    expect(row.error ?? '').not.toContain('idle-killed')
  }, 20_000)




})
