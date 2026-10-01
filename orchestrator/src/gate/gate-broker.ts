// concern: worker gate broker
/** Host-side execution of gate requests recorded by sandboxed repository workers. */

import { spawn, spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { db, nowIso, writeTransaction } from '../database/db.ts'
import { terminateProcessGroup } from '../idle-kill.ts'
import { workerGateEnvironment } from '../issue/issue-shell.ts'
import type { MainStackConsumer } from '../project/project-settings.ts'
import { ensureMainStackStarted } from '../resources/main-stack.ts'
import { resolveReviewMergeBase } from '../review/review-target.ts'
import { runArtifactsDir } from '../run/run-artifacts.ts'
import {
  boundedGateOutputTail,
  brokerGateEnvironment,
  decideGateHeadCommit,
  GATE_CLOSE_REASON,
  GATE_COMMAND_TIMEOUT_MS,
  isGateToolingPath,
  resolveGateCommand,
} from './gate-decision.ts'

/** A pending check is a plain read; only an actual claim takes the write lock. */
const GATE_REQUEST_POLL_MS = 1000

type PendingGate = { id: number; run_id: number }
type ActiveGate = { completion: Promise<void>; cancel(reason: string): Promise<void> }

const PENDING_GATE_SQL = `SELECT id,run_id FROM gate_execution
  WHERE run_id=? AND started_at IS NULL AND finished_at IS NULL ORDER BY id LIMIT 1`

function claimPendingGate(runId: number): PendingGate | null {
  if (!db().query(PENDING_GATE_SQL).get(runId)) return null
  return writeTransaction(() => {
    const row = db().query(PENDING_GATE_SQL).get(runId) as PendingGate | null
    if (!row) return null
    const claimed = db()
      .query('UPDATE gate_execution SET started_at=? WHERE id=? AND started_at IS NULL')
      .run(nowIso(), row.id)
    return claimed.changes === 1 ? row : null
  })
}

function gatePlan(runId: number): {
  command: string
  worktree: string
  baseCommit: string
  trunk: string | null
  mainStackConsumers: MainStackConsumer[] | undefined
} {
  const row = db()
    .query(
      `SELECT r.worktree,r.base_commit,p.settings
       FROM run r JOIN project p ON p.id=r.project_id WHERE r.id=?`,
    )
    .get(runId) as {
    worktree: string | null
    base_commit: string | null
    settings: string | null
  } | null
  if (!row?.worktree) throw new Error(`run ${runId} has no recorded worktree`)
  if (!row.base_commit) throw new Error(`run ${runId} has no recorded base commit`)
  const settings = JSON.parse(row.settings ?? '{}') as {
    gate?: unknown
    trunk?: unknown
    mainStack?: { consumers?: MainStackConsumer[] }
  }
  if (typeof settings.gate !== 'string' || !settings.gate.trim()) {
    throw new Error(`run ${runId}'s project has no registered gate`)
  }
  return {
    command: settings.gate.trim(),
    worktree: row.worktree,
    baseCommit: row.base_commit,
    trunk:
      typeof settings.trunk === 'string' && settings.trunk.trim() ? settings.trunk.trim() : null,
    mainStackConsumers: settings.mainStack?.consumers,
  }
}

function gitPaths(worktree: string, args: string[]): string[] {
  const result = spawnSync('git', args, { cwd: worktree, encoding: 'buffer' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString().trim()}`)
  }
  return result.stdout.toString().split('\0').filter(Boolean)
}

function changedGateTooling(
  plan: ReturnType<typeof gatePlan>,
  log: (line: string) => void,
): string[] {
  let base = plan.baseCommit
  try {
    if (!plan.trunk) throw new Error('the project has no registered trunk')
    const mergeBase = resolveReviewMergeBase(plan.worktree, 'HEAD', plan.trunk)
    if (!mergeBase) throw new Error(`no merge-base with trunk ${plan.trunk}`)
    base = mergeBase
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).replaceAll('\n', ' ')
    log(`gate tooling diff fell back to recorded base ${plan.baseCommit}: ${reason}\n`)
  }
  const changed = new Set([
    ...gitPaths(plan.worktree, ['diff', '--name-only', '-z', base, '--']),
    ...gitPaths(plan.worktree, ['ls-files', '--others', '--exclude-standard', '-z']),
  ])
  return [...changed].filter((path) => isGateToolingPath(path, plan.command)).sort()
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  await new Promise<void>((resolve) => {
    child.once('close', () => resolve())
    child.once('error', () => resolve())
  })
}

function startGateExecution(
  request: PendingGate,
  scratchDir: string,
  environment: Record<string, string>,
  registerActive: (terminate: () => Promise<void>) => () => void,
): ActiveGate {
  let child: ReturnType<typeof spawn> | null = null
  let termination: Promise<void> | null = null
  let cancelledReason: string | null = null
  const stop = (reason?: string): Promise<void> => {
    if (reason) cancelledReason ??= reason
    if (!child || child.exitCode !== null) return Promise.resolve()
    termination ??= terminateProcessGroup(child.pid ?? 0, { direct: child }).then((result) => {
      if (!result.exited) throw new Error(result.reason ?? 'gate process group did not exit')
    })
    return termination
  }
  let completion!: Promise<void>
  const unregister = registerActive(async () => {
    await stop(GATE_CLOSE_REASON)
    await completion
  })
  completion = (async () => {
    mkdirSync(scratchDir, { recursive: true })
    const scratchPath = join(scratchDir, `gate-${request.id}.log`)
    const artifactPath = join(runArtifactsDir(request.run_id), `gate-${request.id}.log`)
    const fd = openSync(scratchPath, 'w')
    const started = Date.now()
    let tail = ''
    let timedOut = false
    let exitCode = -1
    let command: string | null = null
    const record = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      writeSync(fd, bytes)
      tail = boundedGateOutputTail(tail + bytes.toString())
    }
    try {
      const plan = gatePlan(request.run_id)
      const mainCheckout = environment.ORCH_MAIN_CHECKOUT
      if (!mainCheckout) throw new Error(`run ${request.run_id} has no recorded main checkout`)
      ensureMainStackStarted({
        projectPath: mainCheckout,
        declaredConsumers: plan.mainStackConsumers,
        consumer: 'gate',
      })
      command = resolveGateCommand(plan.command, plan.worktree)
      const toolingPaths = changedGateTooling(plan, record)
      const headCommit = decideGateHeadCommit({
        headCommit:
          gitPaths(plan.worktree, ['rev-parse', '--verify', 'HEAD^{commit}'])[0]?.trim() ?? '',
        porcelainPaths: gitPaths(plan.worktree, [
          'status',
          '--porcelain',
          '-z',
          '--untracked-files=all',
        ]),
      })
      db()
        .query(
          'UPDATE gate_execution SET tooling_paths=?,resolved_command=?,head_commit=? WHERE id=?',
        )
        .run(JSON.stringify(toolingPaths), command, headCommit, request.id)
      child = spawn('sh', ['-c', command], {
        cwd: plan.worktree,
        env: brokerGateEnvironment(workerGateEnvironment(process.env), process.env, environment),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.stdout?.on('data', record)
      child.stderr?.on('data', record)
      child.once('error', (error) => record(`gate could not start: ${String(error)}\n`))
      const timeout = setTimeout(() => {
        timedOut = true
        void stop()
      }, GATE_COMMAND_TIMEOUT_MS)
      await waitForExit(child)
      clearTimeout(timeout)
      if (termination) await termination
      exitCode = child.exitCode ?? -1
      if (timedOut) record(`\ngate timed out after ${GATE_COMMAND_TIMEOUT_MS}ms\n`)
    } catch (error) {
      const line = `gate broker failed: ${String(error)}\n`
      writeSync(fd, line)
      tail = boundedGateOutputTail(tail + line)
      if (termination) throw error
    } finally {
      closeSync(fd)
    }
    db()
      .query(
        `UPDATE gate_execution SET finished_at=?,exit_code=?,timed_out=?,elapsed_ms=?,
         output_tail=?,output_artifact=?,cancelled_reason=?,resolved_command=COALESCE(resolved_command,?)
         WHERE id=?`,
      )
      .run(
        nowIso(),
        exitCode,
        timedOut ? 1 : 0,
        Date.now() - started,
        tail,
        artifactPath,
        cancelledReason,
        command,
        request.id,
      )
  })().finally(unregister)
  return { completion, cancel: (reason) => stop(reason) }
}

export type GateBroker = { close(): Promise<void> }

/** Poll while the supervised worker lives; no resident service is introduced. */
export function startGateBroker(input: {
  runId: number
  scratchDir: string
  environment: Record<string, string>
  registerActive?: (terminate: () => Promise<void>) => () => void
}): GateBroker {
  let closed = false
  let active: ActiveGate | null = null
  const registerActive = input.registerActive ?? (() => () => {})
  const poll = () => {
    if (closed || active) return
    const request = claimPendingGate(input.runId)
    if (!request) return
    const execution = startGateExecution(
      request,
      input.scratchDir,
      input.environment,
      registerActive,
    )
    active = execution
    void execution.completion.then(
      () => {
        if (active === execution) active = null
      },
      () => {},
    )
  }
  const timer = setInterval(poll, GATE_REQUEST_POLL_MS)
  poll()
  return {
    async close() {
      closed = true
      clearInterval(timer)
      if (active) {
        await active.cancel(GATE_CLOSE_REASON)
        await active.completion
      }
      writeTransaction(() => {
        db().query('UPDATE run SET gate_requests_closed=1 WHERE id=?').run(input.runId)
        db()
          .query(
            `UPDATE gate_execution SET finished_at=?,exit_code=-1,timed_out=0,elapsed_ms=0,
             cancelled_reason=? WHERE run_id=? AND finished_at IS NULL`,
          )
          .run(nowIso(), GATE_CLOSE_REASON, input.runId)
      })
    },
  }
}
