// concern: workflows
/** Records a read-only probe command as an artifact. Must not know floor decisions. */
import type { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { containsSecretShaped } from '../../../shared/secret-shaped.ts'
import { db, nowIso, sessionId, writableDb, writeTransaction } from '../database/db.ts'
import { boundedGateOutputTail, GATE_OUTPUT_TAIL_BYTES } from '../gate/gate-decision.ts'
import { type Project, projectAt } from '../project/projects.ts'
import {
  probeSandboxProfile,
  resetSandbox,
  SRT_LIBRARY,
  sandboxLaunchArgv,
  srtInstalled,
} from '../sandbox/sandbox.ts'

const PROBE_WITHHELD = '[withheld: secret-shaped content]'

export type ProbeRunner = (input: { command: string[]; cwd: string }) => {
  exitCode: number
  output: string
}

export type ProbeRecord = { id: number; withheld: boolean }

function probeEnv(scratch: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? homedir(),
    LANG: process.env.LANG ?? 'C.UTF-8',
    TMPDIR: scratch,
  }
}

async function sandboxedRunner(
  command: string[],
  cwd: string,
  project: Project,
): Promise<{
  exitCode: number
  output: string
}> {
  if (!srtInstalled()) {
    throw new Error(
      `orch workflow probe refuses to run unsandboxed; install the sandbox runtime at ${SRT_LIBRARY} with bun install, then retry`,
    )
  }
  const scratch = mkdtempSync(join(tmpdir(), 'orch-probe-'))
  try {
    let launch: string[]
    try {
      launch = await sandboxLaunchArgv(
        probeSandboxProfile({ allowWriteDir: scratch, cwd, project }),
        command[0]!,
        command.slice(1),
      )
    } catch (error) {
      throw new Error(
        `orch workflow probe could not establish a sandbox: ${
          error instanceof Error ? error.message : String(error)
        }; install the sandbox runtime at ${SRT_LIBRARY} with bun install, then retry`,
      )
    }
    const result = spawnSync(launch[0]!, launch.slice(1), {
      cwd,
      encoding: 'utf8',
      env: probeEnv(scratch),
    })
    return { exitCode: result.status ?? -1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
  } finally {
    await resetSandbox()
    rmSync(scratch, { recursive: true, force: true })
  }
}

function headCommit(cwd: string): string | null {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

export async function recordWorkflowProbe(
  command: string[],
  input: {
    cwd?: string
    d?: Database
    runner?: ProbeRunner
    commit?: string | null
  } = {},
): Promise<ProbeRecord> {
  if (!command.length) throw new Error('orch workflow probe needs a command after --')
  const cwd = input.cwd ?? process.cwd()
  const project = projectAt(cwd, input.d ?? db())
  if (!project) throw new Error(`orch workflow probe: no registered project contains ${cwd}`)
  const ran = input.runner
    ? input.runner({ command, cwd })
    : await sandboxedRunner(command, cwd, project)
  const commandJson = JSON.stringify(command)
  const withheld = containsSecretShaped(commandJson) || containsSecretShaped(ran.output)
  const storedCommand = containsSecretShaped(commandJson) ? PROBE_WITHHELD : commandJson
  const tail = boundedGateOutputTail(
    containsSecretShaped(ran.output) || containsSecretShaped(commandJson)
      ? PROBE_WITHHELD
      : ran.output,
    GATE_OUTPUT_TAIL_BYTES,
  )
  const d = input.d ?? writableDb()
  return writeTransaction(() => {
    const row = d
      .query<{ id: number }, (string | number | null)[]>(
        `INSERT INTO probe (command,cwd,head_commit,exit_code,output_tail,withheld,session_id,created_at)
         VALUES (?,?,?,?,?,?,?,?) RETURNING id`,
      )
      .get(
        storedCommand,
        cwd,
        input.commit === undefined ? headCommit(cwd) : input.commit,
        ran.exitCode,
        tail,
        withheld ? 1 : 0,
        sessionId(),
        nowIso(),
      )
    if (!row) throw new Error('probe record was not inserted')
    return { id: row.id, withheld }
  }, d)
}
