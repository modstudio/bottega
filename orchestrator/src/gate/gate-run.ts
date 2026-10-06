// concern: worker gate
/** Runs a project's registered gate as an architect invocation and records the finished row. */
import type { Database } from 'bun:sqlite'
import { spawn, spawnSync } from 'node:child_process'
import { containsSecretShaped } from '../../../shared/secret-shaped.ts'
import { db, nowIso, sessionId, writableDb, writeTransaction } from '../database/db.ts'
import { projectAt } from '../project/projects.ts'
import {
  boundedGateOutputTail,
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

function headCommit(cwd: string): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(
      `orch gate run needs HEAD in ${cwd}: ${result.stderr?.trim() || `git exited ${result.status}`}`,
    )
  }
  return result.stdout.trim()
}

export async function runArchitectGate(input: {
  cwd?: string
  d?: Database
  runner?: ArchitectGateRunner
  commit?: string
  write?: (chunk: string) => void
}): Promise<ArchitectGateRecord> {
  if (process.env.ORCH_DEPTH !== undefined)
    throw new Error('orch gate run is reserved for architect sessions; ORCH_DEPTH is set')
  const caller = sessionId()
  if (!caller)
    throw new Error(
      'orch gate run is reserved for architect sessions; CLAUDE_CODE_SESSION_ID is not set',
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
  const command = resolveGateCommand(gate, project.path)
  const write = input.write ?? ((chunk) => process.stdout.write(chunk))
  const ran = await (input.runner ?? defaultRunner)({ command, cwd, write })
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
        input.commit ?? headCommit(cwd),
        caller,
        cwd,
      )
    if (!row) throw new Error('gate_execution row was not inserted')
    return { id: row.id, exitCode: ran.exitCode }
  }, d)
}
