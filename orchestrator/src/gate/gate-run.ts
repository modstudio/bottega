// concern: worker gate
/** Runs a project's registered gate as an architect invocation and records the finished row. */
import type { Database } from 'bun:sqlite'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { CHECK_EXECUTION_FILE_ENV } from '../../../shared/check-execution.ts'
import { gitToplevel } from '../../../shared/git.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { callerIdentityRefusal } from '../caller-classification.ts'
import {
  callerIdentity,
  db,
  nowIso,
  sessionId,
  writableDb,
  writeTransaction,
} from '../database/db.ts'
import { projectAt } from '../project/projects.ts'
import { ensureMainStackStarted } from '../resources/main-stack.ts'
import { withholdSecretShapedLines } from '../secret-shaped-output.ts'
import {
  gateCheckExecutionPath,
  insertGateCheckExecutions,
  readGateCheckExecutions,
} from './gate-check-executions.ts'
import {
  boundedGateOutputTail,
  decideGateCheckoutRefusal,
  decideGateHeadCommit,
  GATE_CHECKOUT_OPERATION_MARKERS,
  GATE_OUTPUT_TAIL_BYTES,
  resolveGateCommand,
  WORKER_GATE_BASE_ENV,
} from './gate-decision.ts'

type ArchitectGateResult = {
  exitCode: number
  output: string
  startedAt: string
  finishedAt: string
  elapsedMs: number
}

export type ArchitectGateRunner = (input: {
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
  write: (chunk: string) => void
}) => ArchitectGateResult | Promise<ArchitectGateResult>

export type ArchitectGateGitState = (cwd: string) => {
  headCommit: string
  porcelainPaths: readonly string[]
}

export type ArchitectGateCheckout = (cwd: string) => {
  presentMarkers: readonly string[]
  unmergedPaths: readonly string[]
}

type ArchitectGateTopLevel = (cwd: string) => string | null

export type ArchitectGateRecord = { number: number; exitCode: number }

/** Record a worker-style gate request; the broker remains the only executor. */
export function requestGateExecution(runId: string): {
  recordId: string
  number: number
  requestedAt: string
} {
  const requestedAt = nowIso()
  const recordId = newRecordId()
  db()
    .query('INSERT INTO gate_execution (record_id,run_record_id,requested_at) VALUES (?,?,?)')
    .run(recordId, runId, requestedAt)
  const inserted = db()
    .query<{ number: number }, [string]>('SELECT number FROM gate_execution WHERE record_id=?')
    .get(recordId)
  if (!inserted?.number) throw new Error('gate execution request was not inserted')
  return { recordId, number: inserted.number, requestedAt }
}

/** Cancel one request only while it remains unfinished. */
export function cancelPendingGateExecution(recordId: string, reason: string): boolean {
  return (
    db()
      .query(
        `UPDATE gate_execution SET finished_at=?,exit_code=-1,timed_out=0,elapsed_ms=0,
         cancelled_reason=? WHERE record_id=? AND finished_at IS NULL`,
      )
      .run(nowIso(), reason, recordId).changes === 1
  )
}

export function architectGateProcessExitCode(recordedExitCode: number): number {
  return recordedExitCode >= 0 ? recordedExitCode : 1
}

const defaultRunner: ArchitectGateRunner = ({ command, cwd, env, write }) =>
  new Promise((resolve, reject) => {
    const started = Date.now()
    const startedAt = nowIso()
    const child = spawn('sh', ['-c', command], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const record = (chunk: Buffer | string) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString() : chunk
      output += text
      write(text)
    }
    child.stdout?.on('data', record)
    child.stderr?.on('data', record)
    child.once('error', reject)
    child.once('close', (code) => {
      resolve({
        exitCode: code ?? -1,
        output,
        startedAt,
        finishedAt: nowIso(),
        elapsedMs: Date.now() - started,
      })
    })
  })

function gitCommandError(
  cwd: string,
  result: { status: number | null; stderr: string },
  action: string,
) {
  return `${PLATFORM_SLUG} gate run needs ${action} in ${cwd}: ${result.stderr.trim() || `git exited ${result.status}`}`
}

function uniqueUnmergedPaths(stdout: string): string[] {
  const seen = new Set<string>()
  const paths: string[] = []
  for (const entry of stdout.split('\0')) {
    if (!entry) continue
    const tab = entry.lastIndexOf('\t')
    const path = tab === -1 ? entry : entry.slice(tab + 1)
    if (!path || seen.has(path)) continue
    seen.add(path)
    paths.push(path)
  }
  return paths
}

function observeGateCheckoutFacts(cwd: string): {
  presentMarkers: string[]
  unmergedPaths: string[]
} {
  const gitDir = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-dir'], {
    cwd,
    encoding: 'utf8',
  })
  if (gitDir.status !== 0) throw new Error(gitCommandError(cwd, gitDir, 'git dir'))
  const dir = gitDir.stdout.trim()
  const presentMarkers = GATE_CHECKOUT_OPERATION_MARKERS.filter((marker) =>
    existsSync(join(dir, marker)),
  )
  const unmerged = spawnSync('git', ['ls-files', '-u', '-z'], { cwd, encoding: 'utf8' })
  if (unmerged.status !== 0) throw new Error(gitCommandError(cwd, unmerged, 'git ls-files'))
  return {
    presentMarkers: [...presentMarkers],
    unmergedPaths: uniqueUnmergedPaths(unmerged.stdout),
  }
}

export function refuseInProgressCheckout(
  cwd: string,
  observe: ArchitectGateCheckout = observeGateCheckoutFacts,
): void {
  const refusal = decideGateCheckoutRefusal(observe(cwd))
  if (refusal) throw new Error(`${PLATFORM_SLUG} gate run: ${refusal}`)
}

const observeGitState: ArchitectGateGitState = (cwd) => {
  const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
    cwd,
    encoding: 'utf8',
  })
  if (head.status !== 0) throw new Error(gitCommandError(cwd, head, 'HEAD'))
  const status = spawnSync('git', ['status', '--porcelain', '-z', '--untracked-files=all'], {
    cwd,
    encoding: 'utf8',
  })
  if (status.status !== 0) throw new Error(gitCommandError(cwd, status, 'git status'))
  return {
    headCommit: head.stdout.trim(),
    porcelainPaths: status.stdout.split('\0').filter(Boolean),
  }
}

function gateHeadCommit(cwd: string, observe: ArchitectGateGitState): string | null {
  return decideGateHeadCommit(observe(cwd))
}

/** Who may run the gate, in which registered project and checkout, with which command. */
function architectGateTarget(input: {
  cwd?: string
  d?: Database
  topLevel?: ArchitectGateTopLevel
}) {
  if (process.env.BOTTEGA_DEPTH !== undefined)
    throw new Error(
      `${PLATFORM_SLUG} gate run is reserved for architect sessions; BOTTEGA_DEPTH is set`,
    )
  const caller = sessionId()
  if (!caller)
    throw new Error(
      `${PLATFORM_SLUG} gate run is reserved for architect sessions; ${callerIdentityRefusal(callerIdentity(), 'run the gate')}`,
    )
  const cwd = input.cwd ?? process.cwd()
  const project = projectAt(cwd, input.d ?? db())
  if (!project) throw new Error(`${PLATFORM_SLUG} gate run: no registered project contains ${cwd}`)
  const gate = project.settings.gate?.trim()
  if (!gate) {
    throw new Error(
      `${PLATFORM_SLUG} gate run: project ${project.name} has no registered gate; set settings.gate`,
    )
  }
  const checkoutTopLevel = (input.topLevel ?? gitToplevel)(cwd)
  if (!checkoutTopLevel) {
    throw new Error(
      `${PLATFORM_SLUG} gate run: could not resolve the checkout top level for ${cwd}; run ${PLATFORM_SLUG} gate run from inside the checkout to gate`,
    )
  }
  return { caller, project, gate, checkoutTopLevel }
}

export async function runArchitectGate(input: {
  cwd?: string
  d?: Database
  runner?: ArchitectGateRunner
  gitState?: ArchitectGateGitState
  checkout?: ArchitectGateCheckout
  topLevel?: ArchitectGateTopLevel
  write?: (chunk: string) => void
}): Promise<ArchitectGateRecord> {
  const { caller, project, gate, checkoutTopLevel } = architectGateTarget(input)
  refuseInProgressCheckout(checkoutTopLevel, input.checkout ?? observeGateCheckoutFacts)
  ensureMainStackStarted({
    projectId: project.recordId,
    projectName: project.name,
    projectPath: project.path,
    declaration: project.settings.mainStack,
    consumer: 'gate',
    database: input.d,
  })
  const command = resolveGateCommand(gate, checkoutTopLevel)
  const write = input.write ?? ((chunk) => process.stdout.write(chunk))
  const observe = input.gitState ?? observeGitState
  const before = gateHeadCommit(checkoutTopLevel, observe)
  const executionPath = gateCheckExecutionPath()
  const ran = await (input.runner ?? defaultRunner)({
    command,
    cwd: checkoutTopLevel,
    env: { ...process.env, [CHECK_EXECUTION_FILE_ENV]: executionPath },
    write,
  })
  const checkExecutions = readGateCheckExecutions(executionPath, write)
  // A gate that rewrites the tree while it runs tested something other than HEAD.
  const commit =
    before !== null && gateHeadCommit(checkoutTopLevel, observe) === before ? before : null
  const tail = boundedGateOutputTail(
    withholdSecretShapedLines(ran.output, [process.env[WORKER_GATE_BASE_ENV] ?? '', before ?? '']),
    GATE_OUTPUT_TAIL_BYTES,
  )
  const d = input.d ?? writableDb()
  return writeTransaction(() => {
    const recordId = newRecordId()
    d.query(
      `INSERT INTO gate_execution
          (record_id,run_record_id,requested_at,started_at,finished_at,exit_code,timed_out,elapsed_ms,
           output_tail,output_artifact,tooling_paths,resolved_command,head_commit,session_id,cwd)
         VALUES (?,NULL,?,?,?,?,0,?,?,NULL,'[]',?,?,?,?)`,
    ).run(
      recordId,
      ran.startedAt,
      ran.startedAt,
      ran.finishedAt,
      ran.exitCode,
      ran.elapsedMs,
      tail,
      command,
      commit,
      caller,
      checkoutTopLevel,
    )
    const row = d
      .query<{ number: number }, [string]>('SELECT number FROM gate_execution WHERE record_id=?')
      .get(recordId)
    if (!row?.number) throw new Error('gate_execution row was not inserted')
    insertGateCheckExecutions(d, recordId, checkExecutions)
    return { number: row.number, exitCode: ran.exitCode }
  }, d)
}
