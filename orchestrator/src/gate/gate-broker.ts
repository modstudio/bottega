// concern: worker gate broker
/** Host-side execution of gate requests recorded by sandboxed writing workers. */

import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { db, nowIso, writeTransaction } from '../database/db.ts'
import { terminateProcessGroup } from '../idle-kill.ts'
import { FILED_ISSUE_COMMAND_TIMEOUT_MS } from '../issue/issue-shell.ts'
import { runArtifactsDir } from '../run/run-artifacts.ts'
import { boundedGateOutputTail } from './gate-decision.ts'

const GATE_REQUEST_POLL_MS = 100

type PendingGate = { id: number; run_id: number }

function claimPendingGate(runId: number): PendingGate | null {
  return writeTransaction(() => {
    const row = db()
      .query(
        `SELECT id,run_id FROM gate_execution
         WHERE run_id=? AND started_at IS NULL AND finished_at IS NULL ORDER BY id LIMIT 1`,
      )
      .get(runId) as PendingGate | null
    if (!row) return null
    const claimed = db()
      .query('UPDATE gate_execution SET started_at=? WHERE id=? AND started_at IS NULL')
      .run(nowIso(), row.id)
    return claimed.changes === 1 ? row : null
  })
}

function gatePlan(runId: number): { command: string; worktree: string } {
  const row = db()
    .query(
      `SELECT r.worktree,p.settings
       FROM run r JOIN project p ON p.id=r.project_id WHERE r.id=?`,
    )
    .get(runId) as { worktree: string | null; settings: string | null } | null
  if (!row?.worktree) throw new Error(`run ${runId} has no recorded worktree`)
  const settings = JSON.parse(row.settings ?? '{}') as { gate?: unknown }
  if (typeof settings.gate !== 'string' || !settings.gate.trim()) {
    throw new Error(`run ${runId}'s project has no registered gate`)
  }
  return { command: settings.gate.trim(), worktree: row.worktree }
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  await new Promise<void>((resolve) => {
    child.once('close', () => resolve())
    child.once('error', () => resolve())
  })
}

async function executeGate(
  request: PendingGate,
  scratchDir: string,
  environment: Record<string, string>,
): Promise<void> {
  mkdirSync(scratchDir, { recursive: true })
  const scratchPath = join(scratchDir, `gate-${request.id}.log`)
  const artifactPath = join(runArtifactsDir(request.run_id), `gate-${request.id}.log`)
  const fd = openSync(scratchPath, 'w')
  const started = Date.now()
  let tail = ''
  let timedOut = false
  let exitCode = -1
  try {
    const plan = gatePlan(request.run_id)
    const child = spawn('sh', ['-lc', plan.command], {
      cwd: plan.worktree,
      env: { ...process.env, ...environment },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const record = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      writeSync(fd, bytes)
      tail = boundedGateOutputTail(tail + bytes.toString())
    }
    child.stdout?.on('data', record)
    child.stderr?.on('data', record)
    child.once('error', (error) => record(`gate could not start: ${String(error)}\n`))
    const timeout = setTimeout(() => {
      timedOut = true
      void terminateProcessGroup(child.pid ?? 0, { direct: child })
    }, FILED_ISSUE_COMMAND_TIMEOUT_MS)
    await waitForExit(child)
    clearTimeout(timeout)
    exitCode = child.exitCode ?? -1
    if (timedOut) record(`\ngate timed out after ${FILED_ISSUE_COMMAND_TIMEOUT_MS}ms\n`)
  } catch (error) {
    const line = `gate broker failed: ${String(error)}\n`
    writeSync(fd, line)
    tail = boundedGateOutputTail(tail + line)
  } finally {
    closeSync(fd)
  }
  db()
    .query(
      `UPDATE gate_execution SET finished_at=?,exit_code=?,timed_out=?,elapsed_ms=?,
       output_tail=?,output_artifact=? WHERE id=?`,
    )
    .run(nowIso(), exitCode, timedOut ? 1 : 0, Date.now() - started, tail, artifactPath, request.id)
}

export type GateBroker = { close(): Promise<void> }

/** Poll while the supervised worker lives; no resident service is introduced. */
export function startGateBroker(input: {
  runId: number
  scratchDir: string
  environment: Record<string, string>
}): GateBroker {
  let closed = false
  let active: Promise<void> | null = null
  const poll = () => {
    if (closed || active) return
    const request = claimPendingGate(input.runId)
    if (!request) return
    active = executeGate(request, input.scratchDir, input.environment).finally(() => {
      active = null
    })
  }
  const timer = setInterval(poll, GATE_REQUEST_POLL_MS)
  poll()
  return {
    async close() {
      closed = true
      clearInterval(timer)
      await active
    },
  }
}
