// concern: worker gate
/** Runs a project's registered gate as an architect invocation and records the finished row. */
import type { Database } from 'bun:sqlite'
import { spawn, spawnSync } from 'node:child_process'
import { gitToplevel } from '../../../shared/git.ts'
import { containsSecretShaped } from '../../../shared/secret-shaped.ts'
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

const defaultRunner: ArchitectGateRunner = ({ command, cwd, write }) =>
  new Promise((resolve, reject) => {
    const started = Date.now()
    const startedAt = nowIso()
    const child = spawn('sh', ['-c', command], {
      cwd,
      env: process.env,
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
      `orch gate run needs HEAD in ${cwd}: ${head.stderr?.trim() || `git exited ${head.status}`}`,
    )
  }
  const status = spawnSync('git', ['status', '--porcelain', '-z', '--untracked-files=all'], {
    cwd,
    encoding: 'utf8',
  })
  if (status.status !== 0) {
    throw new Error(
      `orch gate run needs git status in ${cwd}: ${status.stderr?.trim() || `git exited ${status.status}`}`,
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

export async function runArchitectGate(input: {
  cwd?: string
  d?: Database
  runner?: ArchitectGateRunner
  gitState?: ArchitectGateGitState
  topLevel?: ArchitectGateTopLevel
  write?: (chunk: string) => void
}): Promise<ArchitectGateRecord> {
  if (process.env.ORCH_DEPTH !== undefined)
    throw new Error('orch gate run is reserved for architect sessions; ORCH_DEPTH is set')
  const caller = sessionId()
  if (!caller)
    throw new Error(
      `orch gate run is reserved for architect sessions; ${callerIdentityRefusal(callerIdentity(), 'run the gate')}`,
    )
  const cwd = input.cwd ?? process.cwd()
  const project = projectAt(cwd, input.d ?? db())
  if (!project) throw new Error(`orch gate run: no registered project contains ${cwd}`)
  const gate = project.settings.gate?.trim()
  if (!gate) {
    throw new Error(
      `orch gate run: project ${project.name} has no registered gate; set settings.gate`,
    )
  }
  const checkoutTopLevel = (input.topLevel ?? gitToplevel)(cwd)
  if (!checkoutTopLevel) {
    throw new Error(
      `orch gate run: could not resolve the checkout top level for ${cwd}; run orch gate run from inside the checkout to gate`,
    )
  }
  ensureMainStackStarted({
    projectId: project.id,
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
  const ran = await (input.runner ?? defaultRunner)({ command, cwd: checkoutTopLevel, write })
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
          (run_id,requested_at,started_at,finished_at,exit_code,timed_out,elapsed_ms,
           output_tail,output_artifact,tooling_paths,resolved_command,head_commit,session_id,cwd)
         VALUES (NULL,?,?,?,?,0,?,?,NULL,'[]',?,?,?,?) RETURNING id`,
      )
      .get(
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
    return { id: row.id, exitCode: ran.exitCode }
  }, d)
}
