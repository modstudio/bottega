// concern: worker gate
/** Runs a project's registered gate as an architect invocation and records the finished row. */
import type { Database } from 'bun:sqlite'
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  CHECK_EXECUTION_FILE_ENV,
  type CheckExecutionRecord,
  parseCheckExecutionLines,
} from '../../../shared/check-execution.ts'
import { gitToplevel } from '../../../shared/git.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { containsSecretShaped } from '../../../shared/secret-shaped.ts'
import { resolveOrchestratorDatabase } from '../../../shared/state-directory.ts'
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
import {
  boundedGateOutputTail,
  decideGateHeadCommit,
  GATE_OUTPUT_TAIL_BYTES,
  resolveGateCommand,
} from './gate-decision.ts'

const GATE_OUTPUT_WITHHELD = '[withheld: secret-shaped content]'

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

type ArchitectGateTopLevel = (cwd: string) => string | null

export type ArchitectGateRecord = { id: number; exitCode: number }

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

const observeGitState: ArchitectGateGitState = (cwd) => {
  const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
    cwd,
    encoding: 'utf8',
  })
  if (head.status !== 0) {
    throw new Error(
      `${PLATFORM_SLUG} gate run needs HEAD in ${cwd}: ${head.stderr?.trim() || `git exited ${head.status}`}`,
    )
  }
  const status = spawnSync('git', ['status', '--porcelain', '-z', '--untracked-files=all'], {
    cwd,
    encoding: 'utf8',
  })
  if (status.status !== 0) {
    throw new Error(
      `${PLATFORM_SLUG} gate run needs git status in ${cwd}: ${status.stderr?.trim() || `git exited ${status.status}`}`,
    )
  }
  return {
    headCommit: head.stdout.trim(),
    porcelainPaths: status.stdout.split('\0').filter(Boolean),
  }
}

function gateHeadCommit(cwd: string, observe: ArchitectGateGitState): string | null {
  return decideGateHeadCommit(observe(cwd))
}

function checkExecutionPath(): string {
  return join(
    dirname(resolveOrchestratorDatabase(process.env)),
    `check-execution-${crypto.randomUUID()}.jsonl`,
  )
}

function readCheckExecutions(path: string, write: (chunk: string) => void): CheckExecutionRecord[] {
  let records: CheckExecutionRecord[] = []
  try {
    const parsed = parseCheckExecutionLines(readFileSync(path, 'utf8'))
    records = parsed.records
    if (parsed.rejected) write(`check execution records rejected ${parsed.rejected} line(s)\n`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      write(`check execution records could not be read: ${String(error)}\n`)
    }
  } finally {
    try {
      unlinkSync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        write(`check execution records could not be removed: ${String(error)}\n`)
      }
    }
  }
  return records
}

/** Who may run the gate, in which registered project and checkout, with which command. */
function architectGateTarget(input: {
  cwd?: string
  d?: Database
  topLevel?: ArchitectGateTopLevel
}) {
  if (process.env.ORCH_DEPTH !== undefined)
    throw new Error(
      `${PLATFORM_SLUG} gate run is reserved for architect sessions; ORCH_DEPTH is set`,
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
  topLevel?: ArchitectGateTopLevel
  write?: (chunk: string) => void
}): Promise<ArchitectGateRecord> {
  const { caller, project, gate, checkoutTopLevel } = architectGateTarget(input)
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
  const executionPath = checkExecutionPath()
  const ran = await (input.runner ?? defaultRunner)({
    command,
    cwd: checkoutTopLevel,
    env: { ...process.env, [CHECK_EXECUTION_FILE_ENV]: executionPath },
    write,
  })
  const checkExecutions = readCheckExecutions(executionPath, write)
  // A gate that rewrites the tree while it runs tested something other than HEAD.
  const commit =
    before !== null && gateHeadCommit(checkoutTopLevel, observe) === before ? before : null
  const tail = boundedGateOutputTail(
    containsSecretShaped(ran.output) ? GATE_OUTPUT_WITHHELD : ran.output,
    GATE_OUTPUT_TAIL_BYTES,
  )
  const d = input.d ?? writableDb()
  return writeTransaction(() => {
    const row = d
      .query<{ id: number }, (string | number | null)[]>(
        `INSERT INTO gate_execution
          (record_id,run_id,requested_at,started_at,finished_at,exit_code,timed_out,elapsed_ms,
           output_tail,output_artifact,tooling_paths,resolved_command,head_commit,session_id,cwd)
         VALUES (?,NULL,?,?,?,?,0,?,?,NULL,'[]',?,?,?,?) RETURNING id`,
      )
      .get(
        newRecordId(),
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
    if (!row) throw new Error('gate_execution row was not inserted')
    const insertCheck = d.query(
      `INSERT INTO check_execution
        (record_id,gate_execution_id,check_name,category,wall_ms,cpu_ms,exit_code,remaining_count)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    for (const check of checkExecutions) {
      insertCheck.run(
        newRecordId(),
        row.id,
        check.check,
        check.category ?? null,
        check.wallMs,
        check.cpuMs ?? null,
        check.exitCode,
        check.remaining ?? null,
      )
    }
    return { id: row.id, exitCode: ran.exitCode }
  }, d)
}
