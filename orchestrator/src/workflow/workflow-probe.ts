// concern: workflows
/** Records probe and architect-executed commands as artifacts. Must not know floor decisions. */
import type { Database } from 'bun:sqlite'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { constants, homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { containsSecretShaped } from '../../../shared/secret-shaped.ts'
import { callerIdentityRefusal } from '../caller-classification.ts'
import {
  callerIdentity,
  db,
  enableSchemaReloadUnlessRegistered,
  nowIso,
  sessionId,
  storeSchemaVersions,
  writableDb,
  writeTransaction,
} from '../database/db.ts'
import { inFlightMigrationCompatibility } from '../database/migration-compatibility.ts'
import { migrationJournal } from '../database/migrations.ts'
import { boundedGateOutputTail, GATE_OUTPUT_TAIL_BYTES } from '../gate/gate-decision.ts'
import { probeSandboxProfileForCwd, resetSandbox, sandboxLaunchArgv } from '../sandbox/sandbox.ts'
import { sandboxRuntimeAvailability } from '../sandbox/sandbox-runtime.ts'
import { withholdSecretShapedLines } from '../secret-shaped-output.ts'
import { handOffWorkflowEvidence } from './workflow-evidence-handoff.ts'
import type { WorkflowEvidencePayload } from './workflow-evidence-payload.ts'
import {
  decideWorkflowEvidenceRecording,
  type WorkflowEvidenceRecordingDecision,
  workflowEvidenceNotRecordedRefusal,
} from './workflow-evidence-recording.ts'

const PROBE_WITHHELD = '[withheld: secret-shaped content]'

type ProbeRunResult = {
  exitCode: number
  output: string
  secretFound?: boolean
  signal?: NodeJS.Signals | null
}

export type WorkflowOutput = Pick<ProbeRunResult, 'output' | 'secretFound'> & {
  knownIdentifiers?: readonly string[]
  pendingLine?: string
}

/** Retains a bounded tail after redacting secret-shaped lines. */
export function appendWorkflowOutput(current: WorkflowOutput, chunk: string): WorkflowOutput {
  const candidate = (current.pendingLine ?? '') + chunk
  const lastNewline = candidate.lastIndexOf('\n')
  if (lastNewline < 0) return { ...current, pendingLine: candidate }
  const completeLines = candidate.slice(0, lastNewline + 1)
  const redacted = withholdSecretShapedLines(completeLines, current.knownIdentifiers)
  return {
    output: boundedGateOutputTail(current.output + redacted, GATE_OUTPUT_TAIL_BYTES),
    secretFound: current.secretFound === true || redacted !== completeLines,
    knownIdentifiers: current.knownIdentifiers,
    pendingLine: candidate.slice(lastNewline + 1),
  }
}

function finishWorkflowOutput(current: WorkflowOutput): WorkflowOutput {
  const pendingLine = current.pendingLine ?? ''
  const redacted = withholdSecretShapedLines(pendingLine, current.knownIdentifiers)
  return {
    output: boundedGateOutputTail(current.output + redacted, GATE_OUTPUT_TAIL_BYTES),
    secretFound: current.secretFound === true || redacted !== pendingLine,
  }
}
export type ProbeRunner = (input: {
  command: string[]
  cwd: string
}) => ProbeRunResult | Promise<ProbeRunResult>

export type ProbeRecord = {
  id: number
  withheld: boolean
  exitCode: number
  signal: NodeJS.Signals | null
  outputTail: string
}
type RecordedArtifact = Pick<ProbeRecord, 'id' | 'withheld' | 'outputTail'>

function finishRecord(recorded: RecordedArtifact, ran: ProbeRunResult): ProbeRecord {
  return { ...recorded, exitCode: ran.exitCode, signal: ran.signal ?? null }
}

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
  knownIdentifiers: readonly string[],
): Promise<ProbeRunResult> {
  const runtime = sandboxRuntimeAvailability()
  if (!runtime.available) {
    throw new Error(`${PLATFORM_SLUG} workflow probe refuses to run unsandboxed; ${runtime.remedy}`)
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
        `${PLATFORM_SLUG} workflow probe could not establish a sandbox: ${
          error instanceof Error ? error.message : String(error)
        }; ${runtime.remedy}`,
      )
    }
    return await streamingRunner(launch, {
      cwd,
      env: probeEnv(scratch),
      stdin: 'ignore',
      write: () => {},
      knownIdentifiers,
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

function resolveEvidenceHead(
  cwd: string,
  input: { commit?: string | null; resolveHeadCommit?: (cwd: string) => string | null },
): string | null {
  return input.commit === undefined ? (input.resolveHeadCommit ?? headCommit)(cwd) : input.commit
}

export async function recordWorkflowProbe(
  command: string[],
  input: {
    cwd?: string
    d?: Database
    runner?: ProbeRunner
    commit?: string | null
    resolveHeadCommit?: (cwd: string) => string | null
  } = {},
): Promise<ProbeRecord> {
  if (!command.length) throw new Error(`${PLATFORM_SLUG} workflow probe needs a command after --`)
  const cwd = input.cwd ?? process.cwd()
  const database = input.d ?? db()
  // Capture the head the probe command will run against.
  const preCommandHead = resolveEvidenceHead(cwd, input)
  probeSandboxProfileForCwd({ allowWriteDir: cwd, cwd, database })
  const ran = input.runner
    ? await input.runner({ command, cwd })
    : await sandboxedRunner(command, cwd, database, [preCommandHead ?? ''])
  // Capture the head the completed probe proves, retaining the prior head if its cwd disappeared.
  const evidenceHead = resolveEvidenceHead(cwd, input) ?? preCommandHead
  const recorded = await recordWorkflowCommand(command, cwd, ran, 'probe', {
    ...input,
    commit: evidenceHead,
    preCommandCommit: preCommandHead,
  })
  return finishRecord(recorded, ran)
}

async function execRunner(
  command: string[],
  cwd: string,
  write: (chunk: string) => void,
  knownIdentifiers: readonly string[],
): Promise<ProbeRunResult> {
  return streamingRunner(command, {
    cwd,
    env: process.env,
    stdin: 'inherit',
    write,
    knownIdentifiers,
  })
}

async function streamingRunner(
  command: string[],
  input: {
    cwd: string
    env: NodeJS.ProcessEnv
    stdin: 'ignore' | 'inherit'
    write: (chunk: string) => void
    knownIdentifiers: readonly string[]
  },
): Promise<ProbeRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), {
      cwd: input.cwd,
      env: input.env,
      stdio: [input.stdin, 'pipe', 'pipe'],
    })
    let streamed: WorkflowOutput = {
      output: '',
      secretFound: false,
      knownIdentifiers: input.knownIdentifiers,
    }
    const record = (chunk: Buffer | string) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString() : chunk
      streamed = appendWorkflowOutput(streamed, text)
      input.write(text)
    }
    child.stdout?.on('data', record)
    child.stderr?.on('data', record)
    child.once('error', (error) =>
      reject(new Error(`command could not be started: ${error.message}`, { cause: error })),
    )
    child.once('close', (code, signal) =>
      resolve({
        exitCode: code ?? -1,
        ...finishWorkflowOutput(streamed),
        signal,
      }),
    )
  })
}

async function recordWorkflowCommand(
  command: string[],
  cwd: string,
  ran: ProbeRunResult,
  kind: 'probe' | 'exec',
  input: { d?: Database; commit?: string | null; preCommandCommit?: string | null },
): Promise<RecordedArtifact> {
  const commandJson = JSON.stringify(command)
  const redactedOutput = withholdSecretShapedLines(ran.output, [
    input.commit ?? '',
    input.preCommandCommit ?? '',
  ])
  const commandSecret = containsSecretShaped(commandJson)
  const storedCommand = commandSecret ? PROBE_WITHHELD : commandJson
  const tail = boundedGateOutputTail(redactedOutput, GATE_OUTPUT_TAIL_BYTES)
  const withheld = tail === PROBE_WITHHELD
  const d = input.d ?? writableDb()
  return writeTransaction(() => {
    // head_commit is the checkout head after the command for every workflow evidence row.
    const row = d
      .query<{ id: number }, (string | number | null)[]>(
        `INSERT INTO probe (record_id,command,cwd,head_commit,pre_command_head_commit,exit_code,output_tail,withheld,command_withheld,session_id,created_at,kind)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
      )
      .get(
        newRecordId(),
        storedCommand,
        cwd,
        input.commit ?? null,
        input.preCommandCommit ?? null,
        ran.exitCode,
        tail,
        withheld ? 1 : 0,
        commandSecret ? 1 : 0,
        sessionId(),
        nowIso(),
        kind,
      )
    if (!row) throw new Error('probe record was not inserted')
    return { id: row.id, withheld, outputTail: tail }
  }, d)
}

/** A finished child whose evidence row was not written; it carries that child's own status. */
class WorkflowEvidenceNotRecordedError extends Error {
  readonly exitCode: number
  constructor(message: string, exitCode: number) {
    super(message)
    this.exitCode = exitCode
  }
}

/** Refusals exec and its receiving form share: only an architect session records exec evidence. */
function assertWorkflowExecCaller(): void {
  if (process.env.BOTTEGA_DEPTH !== undefined)
    throw new Error(
      `${PLATFORM_SLUG} workflow exec is reserved for architect sessions; BOTTEGA_DEPTH is set`,
    )
  if (!sessionId())
    throw new Error(
      `${PLATFORM_SLUG} workflow exec is reserved for architect sessions; ${callerIdentityRefusal(callerIdentity(), 'execute a workflow')}`,
    )
}

/** The shell status a child reports: its exit code, or the signal's offset. */
export function wrappedCommandExitCode(ran: {
  exitCode: number
  signal?: NodeJS.Signals | null
}): number {
  return ran.signal ? 128 + constants.signals[ran.signal] : ran.exitCode
}

/**
 * Gathers the versions the child may have moved between, then asks the decision.
 * `workflow probe` shares the row writer but not this seam: handing a probe off
 * would need a kind-carrying payload and a second receiving form, so a probe whose
 * child migrated the store keeps its own loud stale-schema refusal.
 */
function evidenceRecordingDecision(): WorkflowEvidenceRecordingDecision {
  const versions = storeSchemaVersions()
  return decideWorkflowEvidenceRecording({
    openedSchemaVersion: versions?.opened ?? null,
    storeSchemaVersion: versions?.store ?? null,
    compatibility: versions
      ? inFlightMigrationCompatibility(migrationJournal(), versions.opened, versions.store)
      : 'incompatible',
  })
}

export async function recordWorkflowExec(
  command: string[],
  input: {
    cwd?: string
    d?: Database
    runner?: ProbeRunner
    commit?: string | null
    write?: (chunk: string) => void
    registeredProject?: boolean
    resolveHeadCommit?: (cwd: string) => string | null
  } = {},
): Promise<ProbeRecord> {
  if (!command.length) throw new Error(`${PLATFORM_SLUG} workflow exec needs a command after --`)
  assertWorkflowExecCaller()
  const cwd = input.cwd ?? process.cwd()
  // Capture the head the exec command will run against.
  const commandHead = resolveEvidenceHead(cwd, input)
  if (input.registeredProject === false)
    throw new Error(`${PLATFORM_SLUG} workflow exec: no registered project contains ${cwd}`)
  // A child may migrate the store; an additive range then reloads instead of refusing the row
  // below. A process that already registered its own reload and refusal keeps them.
  enableSchemaReloadUnlessRegistered()
  const ran = input.runner
    ? await input.runner({ command, cwd })
    : await execRunner(command, cwd, input.write ?? ((chunk) => process.stdout.write(chunk)), [
        commandHead ?? '',
      ])
  // Capture the head the completed exec proves, retaining the prior head if its cwd disappeared.
  const evidenceHead = resolveEvidenceHead(cwd, input) ?? commandHead
  const decision = evidenceRecordingDecision()
  const wrappedExitCode = wrappedCommandExitCode(ran)
  if (decision.action === 'refuse')
    throw new WorkflowEvidenceNotRecordedError(decision.reason, wrappedExitCode)
  if (decision.action === 'hand-off') {
    const handed = handOffWorkflowEvidence({
      command,
      cwd,
      exitCode: ran.exitCode,
      signal: ran.signal ?? null,
      output: ran.output,
      headCommit: evidenceHead,
      preCommandHeadCommit: commandHead,
    })
    if (handed.kind === 'not-recorded')
      throw new WorkflowEvidenceNotRecordedError(
        workflowEvidenceNotRecordedRefusal({ exitCode: wrappedExitCode, detail: handed.detail }),
        wrappedExitCode,
      )
    // The receiving process holds the row and its redacted tail. Exec presents no tail
    // (`presentCommandOutcome` shows one for probe only), so this returns none: the raw
    // output never comes back as a tail the caller could print unredacted.
    return {
      id: handed.id,
      withheld: handed.withheld,
      exitCode: ran.exitCode,
      signal: ran.signal ?? null,
      outputTail: '',
    }
  }
  const recorded = await recordWorkflowCommand(command, cwd, ran, 'exec', {
    ...input,
    commit: evidenceHead,
    preCommandCommit: commandHead,
  })
  return finishRecord(recorded, ran)
}

/**
 * Records the row a hand-off carries. The row is built here, from the payload,
 * through the same writer as exec, so the store's own redaction and tail bounding
 * apply and session identity comes from this process's inherited environment.
 */
export async function recordWorkflowEvidence(
  payload: WorkflowEvidencePayload,
  input: { d?: Database } = {},
): Promise<ProbeRecord> {
  assertWorkflowExecCaller()
  const ran: ProbeRunResult = {
    exitCode: payload.exitCode,
    output: payload.output,
    signal: payload.signal as NodeJS.Signals | null,
  }
  const recorded = await recordWorkflowCommand(payload.command, payload.cwd, ran, 'exec', {
    d: input.d,
    commit: payload.headCommit,
    preCommandCommit: payload.preCommandHeadCommit,
  })
  return finishRecord(recorded, ran)
}
