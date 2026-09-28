// concern: workflows
/** Records probe and architect-executed commands as artifacts. Must not know floor decisions. */
import type { Database } from 'bun:sqlite'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { containsSecretShaped } from '../../../shared/secret-shaped.ts'
import { db, nowIso, sessionId, writableDb, writeTransaction } from '../database/db.ts'
import { boundedGateOutputTail, GATE_OUTPUT_TAIL_BYTES } from '../gate/gate-decision.ts'
import { probeSandboxProfileForCwd, resetSandbox, sandboxLaunchArgv } from '../sandbox/sandbox.ts'
import { sandboxRuntimeAvailability } from '../sandbox/sandbox-runtime.ts'

const PROBE_WITHHELD = '[withheld: secret-shaped content]'

export type ProbeRunner = (input: { command: string[]; cwd: string }) => {
  exitCode: number
  output: string
  secretFound?: boolean
}

export type ProbeRecord = { id: number; withheld: boolean }
export type ExecRecord = ProbeRecord & { exitCode: number }

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
  database: Database,
): Promise<{
  exitCode: number
  output: string
  secretFound: boolean
}> {
  const runtime = sandboxRuntimeAvailability()
  if (!runtime.available) {
    throw new Error(
      `orch workflow probe refuses to run unsandboxed; install the sandbox runtime at ${runtime.location} with bun install, then retry`,
    )
  }
  const scratch = mkdtempSync(join(tmpdir(), 'orch-probe-'))
  try {
    let launch: string[]
    try {
      launch = await sandboxLaunchArgv(
        probeSandboxProfileForCwd({ allowWriteDir: scratch, cwd, database }),
        command[0]!,
        command.slice(1),
      )
    } catch (error) {
      throw new Error(
        `orch workflow probe could not establish a sandbox: ${
          error instanceof Error ? error.message : String(error)
        }; install the sandbox runtime at ${runtime.location} with bun install, then retry`,
      )
    }
    return await streamingRunner(launch, {
      cwd,
      env: probeEnv(scratch),
      stdin: 'ignore',
      write: () => {},
    })
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
  const database = input.d ?? db()
  probeSandboxProfileForCwd({ allowWriteDir: cwd, cwd, database })
  const ran = input.runner
    ? input.runner({ command, cwd })
    : await sandboxedRunner(command, cwd, database)
  return recordWorkflowCommand(command, cwd, ran, 'probe', input)
}

async function execRunner(
  command: string[],
  cwd: string,
  write: (chunk: string) => void,
): Promise<{ exitCode: number; output: string; secretFound: boolean }> {
  return streamingRunner(command, { cwd, env: process.env, stdin: 'inherit', write })
}

async function streamingRunner(
  command: string[],
  input: {
    cwd: string
    env: NodeJS.ProcessEnv
    stdin: 'ignore' | 'inherit'
    write: (chunk: string) => void
  },
): Promise<{ exitCode: number; output: string; secretFound: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), {
      cwd: input.cwd,
      env: input.env,
      stdio: [input.stdin, 'pipe', 'pipe'],
    })
    let output = ''
    let secretFound = false
    const record = (chunk: Buffer | string) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString() : chunk
      const candidate = output + text
      secretFound ||= containsSecretShaped(candidate)
      output = boundedGateOutputTail(candidate, GATE_OUTPUT_TAIL_BYTES)
      input.write(text)
    }
    child.stdout?.on('data', record)
    child.stderr?.on('data', record)
    child.once('error', reject)
    child.once('close', (code) => resolve({ exitCode: code ?? -1, output, secretFound }))
  })
}

async function recordWorkflowCommand(
  command: string[],
  cwd: string,
  ran: { exitCode: number; output: string; secretFound?: boolean },
  kind: 'probe' | 'exec',
  input: { d?: Database; commit?: string | null },
): Promise<ProbeRecord> {
  const commandJson = JSON.stringify(command)
  const outputContainsSecret = ran.secretFound === true || containsSecretShaped(ran.output)
  const withheld = containsSecretShaped(commandJson) || outputContainsSecret
  const storedCommand = containsSecretShaped(commandJson) ? PROBE_WITHHELD : commandJson
  const tail = boundedGateOutputTail(
    outputContainsSecret || containsSecretShaped(commandJson) ? PROBE_WITHHELD : ran.output,
    GATE_OUTPUT_TAIL_BYTES,
  )
  const d = input.d ?? writableDb()
  return writeTransaction(() => {
    const row = d
      .query<{ id: number }, (string | number | null)[]>(
        `INSERT INTO probe (command,cwd,head_commit,exit_code,output_tail,withheld,session_id,created_at,kind)
         VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`,
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
        kind,
      )
    if (!row) throw new Error('probe record was not inserted')
    return { id: row.id, withheld }
  }, d)
}

export async function recordWorkflowExec(
  command: string[],
  input: {
    cwd?: string
    d?: Database
    runner?:
      | ProbeRunner
      | ((input: {
          command: string[]
          cwd: string
        }) => Promise<{ exitCode: number; output: string }>)
    commit?: string | null
    write?: (chunk: string) => void
    registeredProject?: boolean
  } = {},
): Promise<ExecRecord> {
  if (!command.length) throw new Error('orch workflow exec needs a command after --')
  if (process.env.ORCH_DEPTH !== undefined)
    throw new Error('orch workflow exec is reserved for architect sessions; ORCH_DEPTH is set')
  if (!sessionId())
    throw new Error(
      'orch workflow exec is reserved for architect sessions; CLAUDE_CODE_SESSION_ID is not set',
    )
  const cwd = input.cwd ?? process.cwd()
  if (input.registeredProject === false)
    throw new Error(`orch workflow exec: no registered project contains ${cwd}`)
  const ran = input.runner
    ? await input.runner({ command, cwd })
    : await execRunner(command, cwd, input.write ?? ((chunk) => process.stdout.write(chunk)))
  const recorded = await recordWorkflowCommand(command, cwd, ran, 'exec', input)
  return { ...recorded, exitCode: ran.exitCode }
}
