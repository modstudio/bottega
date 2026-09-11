import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AGENTS, addRun, candidates, classify, db, declaredCreate, dir, hermeticGitEnv, JOBS, NEEDS_HUMAN, NOT_EVIDENCE, reapTestProcess, reapTestRun, run, upsertProject, } from '../fixture.ts'
import { stubWorker } from "../stub-worker.ts"
import { trackedTestResidue } from '../residue.ts'
const trackResidue = trackedTestResidue()
import { pidAlive } from '../../src/process-liveness.ts'
import { formatIdleKillError, idleKillMayProceed, idleKillMs, installTestProcessSampler, isGroupKillablePgid, isUninterruptible, isWorkerCpuIdle,
  parseIdleReclaimedMs, parsePsTable, runHasLiveDescendants, shouldIdleKill, terminateProcessGroup,
  DEFAULT_EXTERNAL_WAIT_IDLE_KILL_MS, DEFAULT_IDLE_KILL_MS } from '../../src/idle-kill.ts'
import { PRESERVATION_FAILED_FILE } from '../../src/checkpoint.ts'
import { CPU_LOCAL_JOBS, IDLE_BELOW_WALL_MS, JOB_TIMEOUTS, jobDeclaredWallMs, jobIdleKillMs } from '../../src/jobs.ts'
import { runScratchDir } from '../../src/run-artifacts.ts'
import { isRoutingEvidence } from '../../src/route.ts'
import { harnessHealth } from '../../src/health.ts'
import { installTestTransport, type AgentTransport, type TransportResult } from '../../src/transport.ts'

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


// These assertions exercise real signals, child exit, and process-tree teardown.
describe('idle kill process boundary', () => {
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

  test('a grandchild born after the first sample is re-sampled and SIGKILLed', async () => {
    const alive = new Set([42])
    let n = 0
    let spawned = false
    const signals: Array<{ pid: number; signal: NodeJS.Signals | number }> = []
    const result = await terminateProcessGroup(42, {
      graceMs: 20, killConfirmMs: 20,
      deps: {
        kill(pid, signal) {
          signals.push({ pid, signal })
          if (signal === 'SIGTERM' && (pid === 42 || pid === -42)) alive.delete(42)
          if (signal === 'SIGKILL' && (pid === 43 || pid === -42)) alive.delete(43)
        },
        alive: (pid) => alive.has(pid),
        sample: () => {
          n += 1
          if (n > 1 && !spawned) { alive.add(43); spawned = true }
          const rows: Array<{ pid: number; ppid: number; pgid: number; cpu: number; state: string }> = []
          if (alive.has(42)) rows.push({ pid: 42, ppid: 1, pgid: 42, cpu: 0, state: 'S' })
          if (alive.has(43)) rows.push({ pid: 43, ppid: 1, pgid: 42, cpu: 0, state: 'S' })
          return rows
        },
        selfPgid: () => null,
        wait: async () => {},
      },
    })
    expect(result.exited).toBe(true)
    expect(result.unkillable).toBe(false)
    expect(signals.some((row) => row.pid === 43 && row.signal === 'SIGKILL')).toBe(true)
    expect(alive.has(43)).toBe(false)
  })

  test('a real sleeper is signalled and exits without looping', async () => {
    const child = Bun.spawn(['sleep', '30'], { detached: true, stdout: 'ignore', stderr: 'ignore' })
    try {
      expect(child.pid).toBeGreaterThan(0)
      expectOwnProcessGroup(child.pid)
      const result = await terminateProcessGroup(child.pid, { graceMs: 500, killConfirmMs: 500 })
      expect(result.unkillable).toBe(false)
      expect(result.exited).toBe(true)
      expect(await child.exited).not.toBe(null)
      expect(pidAlive(child.pid)).toBe(false)
    } finally {
      await reapTestProcess(child.pid)
    }
  })

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
        const script = stubWorker({ commits: true, sleepSeconds: 3_600 })
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
    } finally {
      await reapTestRun(runId)
    }
  }, 20_000)

  test('a quiet CPU-burning worker is not idle-killed; the wall still fires independently', async () => {
    const grok = AGENTS.grok!
    const previousBin = grok.bin
    const previousTimeout = grok.timeoutMs
    const script = stubWorker({ burnCpu: true })
    process.env.ORCH_IDLE_KILL_MS = '400'
    process.env.ORCH_DEPTH = '0'
    let runId: number | null = null
    try {
      grok.bin = script
      grok.timeoutMs = 2_500
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
      await reapTestRun(runId)
    }
  }, 15_000)

  test('a silent sleeper is idle-killed before the wall', async () => {
    const grok = AGENTS.grok!
    const previousBin = grok.bin
    const previousTimeout = grok.timeoutMs
    const script = stubWorker({ sleepSeconds: 3_600 })
    process.env.ORCH_IDLE_KILL_MS = '400'
    process.env.ORCH_DEPTH = '0'
    let runId: number | null = null
    try {
      grok.bin = script
      grok.timeoutMs = 20_000
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
      await reapTestRun(runId)
    }
  }, 15_000)

  test('an ACP idle kill is recorded as idle, not the transport timeout, and is not evidence', async () => {
    const transport: AgentTransport = {
      name: 'acp',
      async start() {
        const child = Bun.spawn([stubWorker({ sleepSeconds: 3_600 })], {
          detached: true, stdout: 'ignore', stderr: 'ignore',
        })
        expectOwnProcessGroup(child.pid)
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
      await reapTestRun(runId)
    }
  }, 15_000)

  test('the wall kill sweeps a descendant of the vendor, not only the direct child', async () => {
    const grok = AGENTS.grok!
    const previousBin = grok.bin
    const previousTimeout = grok.timeoutMs
    const script = stubWorker({ sleepSeconds: 3_600 })
    const childPidFile = trackResidue(join(dir, 'fork-sleep.child'))
    process.env.ORCH_STUB_CHILD_PID_FILE = childPidFile
    process.env.ORCH_IDLE_KILL_MS = '60000'
    process.env.ORCH_DEPTH = '0'
    let runId: number | null = null
    let childPid: number | null = null
    try {
      grok.bin = script
      grok.timeoutMs = 2_500
      try {
        const result = await run({
          job: 'summarize', prompt: 'hello', cwd: dir, agent: 'grok', noFailover: true,
        })
        runId = result.id
      } catch (error) {
        runId = (error as Error & { runId?: number }).runId ?? null
      }
      const raw = existsSync(childPidFile) ? readFileSync(childPidFile, 'utf8').trim() : ''
      childPid = raw ? Number(raw) : null
      expect(childPid).toBeGreaterThan(1)
      expect(pidAlive(childPid!)).toBe(false)
      const row = db().query('SELECT agent_pid FROM run WHERE id=?').get(runId) as
        { agent_pid: number | null } | null
      if (row?.agent_pid) expect(pidAlive(row.agent_pid)).toBe(false)
    } finally {
      grok.bin = previousBin
      grok.timeoutMs = previousTimeout
      delete process.env.ORCH_IDLE_KILL_MS
      delete process.env.ORCH_DEPTH
      delete process.env.ORCH_STUB_CHILD_PID_FILE
      await reapTestProcess(childPid)
      await reapTestRun(runId)
    }
  }, 15_000)
})
