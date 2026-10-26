// concern: run-terminal
/**
 * Knows terminal process cleanup, run outcome finalization, evidence recording,
 * terminal row writes, and artifact persistence. Must not know run claiming,
 * live worker execution, run control, dispatch surfaces, or the CLI.
 */
import type { Database } from 'bun:sqlite'
import { writeFileSync } from 'node:fs'
import { MCP_SERVER_NAME, PLATFORM_SLUG, WORKER_MCP_SERVER_NAME } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { AGENTS, refreshAgents } from '../agent/agent-registry.ts'
import { type AskLoopback, recordReplyQuestions } from '../ask/ask.ts'
import {
  type CheckoutRemovalAttribution,
  type CheckoutToWatch,
  type ConfinementEvent,
  classifyCheckoutChanges,
  type FreezeFailure,
  type FrozenCheckout,
  freezeAfterCheckouts,
  overlappingError,
} from '../confinement/confinement.ts'
import type { ReaderReply, ReviewReply, realQuestions, WorkerReply } from '../contract/contract.ts'
import { db, nowIso, tryWriteContention, writeTransaction } from '../database/db.ts'
import { assessEvidence, recordEvidence } from '../evidence/evidence.ts'
import {
  billingHoldForFailure,
  type classify,
  type EffectiveBillingKey,
  FAILS_OVER,
} from '../failure/failure.ts'
import { terminateProcessGroup } from '../idle-kill.ts'
import { isReaderJob, type Job } from '../jobs/jobs.ts'
import type { McpConnection, McpMode } from '../mcp/mcp-preflight.ts'
import { initialQuestionWaitingAt } from '../operator/operator-waiting.ts'
import { finalizeWorkerReply, type OutcomeStatus } from '../outcome.ts'
import type { RunResourceObserver, RunResourceUsage } from '../process-resource-sampler.ts'
import { projectByName, projects } from '../project/projects.ts'
import { machineId } from '../record/machine-identity.ts'
import { teardownTerminalRunResources } from '../resources/resource-ownership.ts'
import { cleanReviewEvidence } from '../review/review.ts'
import { resetSandbox } from '../sandbox/sandbox.ts'
import type { VendorUsage } from '../transport/transport.ts'
import { type Changes, changesIn } from '../worktree/worktree-remove.ts'
import type { Worktree } from '../worktree/worktree-types.ts'
import {
  type CheckpointContainment,
  checkpointRun,
  checkpointSkippedLine,
  latestCheckpoint,
} from './checkpoint.ts'
import {
  closeRunChainQuestions,
  QUESTION_CLOSE_CHAIN_TERMINAL,
  retireRunChainQuestionDeliveries,
} from './question-close.ts'
import {
  persistRunArtifacts,
  persistTerminalSnapshot,
  runArtifactsDir,
  runTerminalReplyPath,
  type TerminalSnapshot,
  terminalRunArtifactPaths,
} from './run-artifacts.ts'
import type { RunCallUsage } from './run-call-usage.ts'
import { rollUpRootAndEnqueue } from './run-liveness.ts'
import { enqueueRunRecord } from './run-outbox.ts'
import { errorTail, live, liveCheckpoints } from './run-process.ts'
import { checkpointRoot, claimIdentity } from './run-resume-kind.ts'
import { observedTestOutcome } from './run-test-outcome.ts'
import { runUsageColumns, runUsageColumnValues } from './run-usage-columns.ts'
import {
  shouldSnapshotSharedGitConfig,
  terminalSharedGitConfigHeader,
} from './shared-git-config.ts'

const TERMINAL_STATUS_SQL = 'SELECT status, failure_kind FROM run WHERE record_id=?'

import { type BlockerRow, blockersToRecord } from './run-terminal-blockers.ts'
import { terminalTurnChanged } from './run-terminal-change.ts'
import { applyConfinementPrecedence, applyVendorTermination } from './run-terminal-precedence.ts'
import {
  applyPrematureFinalFailure,
  terminalPrematureFinalRefusal,
} from './run-terminal-premature.ts'

type TerminalOptions = {
  job: string
  resume?: {
    kind: 'continue' | 'fresh-session' | 'retry-root'
    parent: string
    turn: number
  }
}

export function writeTerminalOperationalState(
  database: Database,
  runId: string,
  resourceUsage: RunResourceUsage | null,
  failureKind: ReturnType<typeof classify> | null,
  agent: string,
  billingHoldDetail?: string,
  endpointKey: EffectiveBillingKey = { secretName: null, source: 'agent', projectName: null },
): void {
  const hold = billingHoldForFailure(failureKind, agent, billingHoldDetail, endpointKey.source)
  if (hold) {
    database
      .query('UPDATE agent SET enabled=?,disabled_reason=? WHERE name=?')
      .run(hold.enabled, hold.disabledReason, agent)
    refreshAgents()
  }
  writeTerminalRunResourceUsage(database, runId, resourceUsage)
}

function writeOperationalState(
  input: TerminalInput,
  resourceUsage: RunResourceUsage | null,
  failureKind: ReturnType<typeof classify> | null,
  name: string,
): void {
  writeTerminalOperationalState(
    db(),
    input.claim.id,
    resourceUsage,
    failureKind,
    name,
    input.billingHoldDetail,
    input.endpointKey,
  )
}

function closeTerminalQuestions(
  database: Database,
  rootId: string,
  status: string,
  failureKind: ReturnType<typeof classify> | null,
): void {
  if (status === 'asking' || status === 'running') return
  if (failureKind && FAILS_OVER.includes(failureKind)) return
  closeRunChainQuestions(database, rootId, QUESTION_CLOSE_CHAIN_TERMINAL)
}

export function finalizeTerminalChain(
  database: Database,
  input: {
    runId: string
    parentRunId: string | null
    status: string
    failureKind: ReturnType<typeof classify> | null
    error: string | null
    record: [machineId: string, finishedAt: string]
  },
): void {
  const rootId = input.parentRunId ?? input.runId
  if (input.parentRunId !== null && input.status === 'asking') {
    database
      .query(
        `UPDATE run SET status='asking', error=?, failure_kind=NULL
        WHERE record_id=? AND parent_run_record_id IS NULL AND status NOT IN ('stopped', 'stale')`,
      )
      .run(input.error, input.parentRunId)
  }
  closeTerminalQuestions(database, rootId, input.status, input.failureKind)
  if (input.parentRunId !== null) {
    rollUpRootAndEnqueue(database, input.parentRunId, null, ...input.record)
  }
  if (
    input.status !== 'asking' &&
    input.status !== 'running' &&
    !(input.failureKind && FAILS_OVER.includes(input.failureKind))
  ) {
    retireRunChainQuestionDeliveries(database, rootId, QUESTION_CLOSE_CHAIN_TERMINAL)
  }
}

type TerminalMcpRuling = {
  connected: 0 | 1 | null
  error: string | null
  requiredFailure: string | null
} | null

export function recordArtifactPersistenceFailure(
  database: Database,
  input: {
    runId: string
    parentRunId: string | null
    error: string | null
    machineId: string
    finishedAt: string
  },
): void {
  writeTransaction(() => {
    database
      .query(
        `UPDATE run SET
           error=CASE WHEN status='stopped' THEN error ELSE ? END
         WHERE record_id=?`,
      )
      .run(input.error, input.runId)
    enqueueRunRecord(database, input.runId, input.machineId, input.finishedAt)
    if (input.parentRunId !== null) {
      rollUpRootAndEnqueue(database, input.parentRunId, null, input.machineId, input.finishedAt)
    }
  }, database)
}

function reviewHidesGap(
  review: ReviewReply | null,
  input: Pick<TerminalInput, 'mcpMode' | 'mcpRuling'>,
  wrongProjectTool: string | null,
): boolean {
  return Boolean(
    review &&
      review.provenance.could_not_verify.length === 0 &&
      (review.provenance.substitutes.length > 0 ||
        (input.mcpMode !== null && input.mcpRuling?.connected !== 1) ||
        wrongProjectTool),
  )
}

function nullableBooleanColumn(value: boolean | null): number | null {
  return value === null ? null : value ? 1 : 0
}

export type TerminalInput = {
  processless?: boolean
  timer: ReturnType<typeof setTimeout> | null
  checkpointTimer: ReturnType<typeof setInterval> | null
  resourceObserver: RunResourceObserver | null
  proc: { pid?: number | null; kill(sig?: number | string): void } | null
  askLoopback: AskLoopback | null
  claim: { id: string; number: number }
  writesJob: boolean
  worktree: Worktree | null
  launchKey: string | null
  failureKind: ReturnType<typeof classify> | null
  billingHoldDetail?: string
  endpointKey: EffectiveBillingKey
  scratchDir: string
  gitConfigEnvironment: Record<string, string> | undefined
  writingAcp: boolean
  checkpointContainment: CheckpointContainment
  opts: TerminalOptions
  watchedCheckouts: CheckoutToWatch[]
  confinementFailures: FreezeFailure[]
  frozenBefore: FrozenCheckout[]
  callerRemoval: CheckoutRemovalAttribution
  removeIsolatedCwd: (() => void) | null
  changes: Changes | null
  provisionedMcpConfig: { measure<T>(operation: () => T): T } | null
  started: number
  retargetDiagnostic: string | null
  error: string | null
  contract: WorkerReply | null
  status: OutcomeStatus
  contractObjects: number
  vendorTerminatedStream: string | null
  acceptedQuestions: ReturnType<typeof realQuestions>
  requestedJob: Job
  checkReviewedCommit: boolean
  output: string
  confinementEvent: ConfinementEvent | null
  parsedReply: ReaderReply | ReviewReply | null
  runProjectName: string | null
  mcpConnection: McpConnection | null
  mcpMode: McpMode | null
  declaredDeliverables: string[]
  mcpSetupHeader: string | null
  outPath: string
  preConfinement: string | null
  callerCwd: string
  promptPath: string
  exitCode: number
  vendorTokens: number | null
  callUsage: RunCallUsage | null
  costUsd: number | null
  vendorUsage: VendorUsage
  effectiveModel: string | null
  resolvedSession: string | null
  name: string
  artifactsPersisted: boolean
  mcpRuling: TerminalMcpRuling
  workerEvents: Array<{ kind: string }>
}

export type TerminalResult = {
  status: OutcomeStatus
  error: string | null
  failureKind: ReturnType<typeof classify> | null
  changes: Changes | null
  output: string
  acceptedQuestions: ReturnType<typeof realQuestions>
  confinementEvent: ConfinementEvent | null
  preConfinement: string | null
  artifactsPersisted: boolean
}

function terminalUsageSnapshot(
  vendorTokens: number | null,
  callUsage: RunCallUsage | null,
  costUsd: number | null,
  vendorUsage: VendorUsage,
  name: string,
) {
  return {
    vendorTokens,
    modelCalls: callUsage?.modelCalls ?? null,
    peakCallTokens: callUsage?.peakCallTokens ?? null,
    vendorCostUsd: costUsd,
    ...runUsageColumns(vendorUsage, AGENTS[name]?.billing),
  }
}

type TerminalCheckpointInput = Pick<
  TerminalInput,
  | 'writesJob'
  | 'claim'
  | 'launchKey'
  | 'scratchDir'
  | 'gitConfigEnvironment'
  | 'checkpointContainment'
  | 'opts'
> & { worktree: Pick<Worktree, 'path' | 'branch'> | null }

export function checkpointTerminalWork(input: TerminalCheckpointInput): string | null {
  const shouldCheckpoint = shouldCheckpointAtTerminal({
    writesJob: input.writesJob,
    hasWorktree: Boolean(input.worktree),
  })
  if (!shouldCheckpoint) return null
  const checkpoint = checkpointRun({
    database: db(),
    runId: input.claim.id,
    worktree: input.worktree!.path,
    branch: input.worktree!.branch,
    taskKey: input.launchKey,
    scratchDir: input.scratchDir,
    guardEnvironment: input.gitConfigEnvironment ?? {},
    containment: input.checkpointContainment,
    final: true,
  })
  if (
    checkpoint.created ||
    latestCheckpoint(db(), checkpointRoot(input.opts.resume, input.claim.id))
  ) {
    db().query('UPDATE run SET work_preserved=1 WHERE record_id=?').run(input.claim.id)
  }
  if (checkpoint.error)
    console.error(`orch: run ${input.claim.id} checkpoint failed: ${checkpoint.error}`)
  const skipped = checkpointSkippedLine(checkpoint, { runId: input.claim.id, final: true })
  if (skipped) console.error(skipped)
  return terminalCheckpointHeader({
    created: checkpoint.created,
    commit: checkpoint.commit,
    error: checkpoint.error,
    worktree: input.worktree!.path,
  })
}

function terminalOperationalHeader(input: TerminalInput, current: string | null): string | null {
  const parts = [
    current,
    checkpointTerminalWork(input),
    terminalSharedGitConfigHeader({
      runId: input.claim.id,
      worktree: input.worktree?.path ?? null,
      expected: shouldSnapshotSharedGitConfig(input.writesJob, input.worktree?.path ?? null),
    }),
  ].filter((part): part is string => Boolean(part))
  return parts.length ? parts.join('\n') : null
}

function terminalAfterCheckouts(
  watched: CheckoutToWatch[],
  before: FrozenCheckout[],
  runId: string,
  removal: CheckoutRemovalAttribution,
): ReturnType<typeof freezeAfterCheckouts> & {
  removal: CheckoutRemovalAttribution
} {
  try {
    return { ...freezeAfterCheckouts({ watched, before, removal }), removal }
  } catch (error) {
    console.error(`orch: could not freeze watched checkouts for run ${runId}: ${error}`)
    return {
      snapshots: [],
      failures: [],
      removedCaller: null,
      removal: { attribution: 'unattributed', removalSession: null, removalRun: null },
    }
  }
}

function isNonPlatformMcpServer(server: string, ownMcpServer: string | null | undefined): boolean {
  return server !== ownMcpServer && server !== MCP_SERVER_NAME && server !== WORKER_MCP_SERVER_NAME
}

/** Which accepted questions have not already been recorded, preserving reply order. */
export function questionsToInsert(
  existingQuestionTexts: string[],
  acceptedQuestions: ReturnType<typeof realQuestions>,
): ReturnType<typeof realQuestions> {
  const norm = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase()
  const already = new Set(existingQuestionTexts.map(norm))
  return acceptedQuestions.filter((item) => {
    const question = norm(item.question)
    if (already.has(question)) return false
    already.add(question)
    return true
  })
}

/** Every writing turn gets one last chance to preserve tracked work. */
export function shouldCheckpointAtTerminal(input: {
  writesJob: boolean
  hasWorktree: boolean
}): boolean {
  return input.writesJob && input.hasWorktree
}

/** Describe the final checkpoint result without changing the worker outcome. */
function terminalCheckpointHeader(input: {
  created: boolean
  commit: string | null
  error: string | null
  worktree: string
}): string | null {
  if (input.error) {
    return `Harness checkpoint failed: ${input.error}; any uncommitted work is still in the worktree at ${input.worktree}.`
  }
  if (input.created) return `Harness checkpoint: committed uncommitted work as ${input.commit!}.`
  return null
}

/** Artifact copy faults retain the worker outcome while remaining visible on the run. */
export function artifactPersistenceOutcome<FailureKind extends string>(input: {
  status: OutcomeStatus
  error: string | null
  failureKind: FailureKind | null
  persistenceError: string
}): { status: OutcomeStatus; error: string; failureKind: FailureKind | null } {
  return {
    status: input.status,
    error: input.error ? `${input.error}\n${input.persistenceError}` : input.persistenceError,
    failureKind: input.failureKind,
  }
}

/**
 * Record a parsed findings reply as review evidence in the terminal
 * transaction. Probe runs are calibration, not product evidence.
 */
export function recordTerminalReviewEvidence(
  database: Database,
  input: {
    runId: string
    parsedReview: ReviewReply | null
    status: string
    failureKind: ReturnType<typeof classify> | null
  },
): string | null {
  if (!input.parsedReview || (input.status !== 'ok' && input.failureKind !== 'escaped')) {
    return null
  }
  const row = database.query('SELECT probe FROM run WHERE record_id=?').get(input.runId) as {
    probe: number | null
  } | null
  if (row?.probe) return null
  return recordEvidence(database, input.runId, input.parsedReview)
}

function boundedConfinementError(message: string): string {
  const bytes = Buffer.from(message)
  if (bytes.length <= 1500) return message
  const suffix = Buffer.from('\n… [error bounded to 1500 bytes]')
  return (
    Buffer.from(bytes.subarray(0, 1500 - suffix.length))
      .toString('utf8')
      .replace(/\uFFFD$/, '') + suffix.toString()
  )
}

function confinementUnverifiedError(failures: FreezeFailure[]): string {
  return boundedConfinementError(
    'checkout confinement could not be verified:\n' +
      failures
        .map(
          (failure) =>
            `registered checkout ${failure.project} at ${failure.path}: ${failure.error}`,
        )
        .join('\n'),
  )
}

function applyRequiredMcpFailure(
  outcome: {
    status: OutcomeStatus
    error: string | null
    failureKind: ReturnType<typeof classify> | null
  },
  ruling: TerminalMcpRuling,
): typeof outcome {
  if (!ruling?.requiredFailure || outcome.status !== 'ok') return outcome
  return {
    status: 'failed',
    error: ruling.requiredFailure,
    failureKind: 'mcp_unverified',
  }
}

function recordTerminalMcpEvidence(
  database: Database,
  runId: string,
  ruling: TerminalMcpRuling,
): void {
  if (!ruling) return
  database
    .query('UPDATE run SET mcp_connected=?, mcp_error=? WHERE record_id=?')
    .run(ruling.connected, ruling.error, runId)
}

function runResourceColumnValues(usage: RunResourceUsage | null) {
  return [
    usage?.cpuMs == null ? null : Math.round(usage.cpuMs),
    usage?.peakRssBytes == null ? null : Math.round(usage.peakRssBytes),
    usage?.samples ?? null,
    usage?.source ?? null,
  ]
}

/** The terminal resource write shared by finalization and its schema contract test. */
export function writeTerminalRunResourceUsage(
  database: Database,
  runId: string,
  usage: RunResourceUsage | null,
): void {
  database
    .query(
      `UPDATE run SET resource_cpu_ms=?, resource_peak_rss_bytes=?, resource_samples=?, resource_source=?
        WHERE record_id=?`,
    )
    .run(...runResourceColumnValues(usage), runId)
}

function clearRunTimers(
  timer: ReturnType<typeof setTimeout> | null,
  checkpointTimer: ReturnType<typeof setInterval> | null,
): void {
  if (timer) clearTimeout(timer)
  if (checkpointTimer) clearInterval(checkpointTimer)
}

function persistTerminalArtifacts(
  id: string,
  readerReply: ReaderReply | null,
  worktree: Worktree | null,
  changes: Changes | null,
): void {
  persistRunArtifacts(id, terminalRunArtifactPaths(id, readerReply), worktree, changes)
}

function recordedReviewedHead(runId: string, required: boolean): string | null {
  if (!required) return null
  return (
    (
      db().query('SELECT head_commit FROM run WHERE record_id=?').get(runId) as {
        head_commit: string | null
      } | null
    )?.head_commit ?? null
  )
}

function insertBlockerRows(runId: string, rows: BlockerRow[], at: string): void {
  if (!rows.length) return
  const q = db().query(
    `INSERT INTO blocker (record_id,run_record_id,at,what,why,impact,source,kind) VALUES (?,?,?,?,?,?,?,?)`,
  )
  for (const r of rows) q.run(newRecordId(), runId, at, r.what, r.why, r.impact, r.source, r.kind)
}

function terminalConfinementSnapshots(input: TerminalInput) {
  const after = terminalAfterCheckouts(
    input.watchedCheckouts,
    input.frozenBefore,
    input.claim.id,
    input.callerRemoval,
  )
  input.confinementFailures.push(...after.failures)
  return { after, before: input.frozenBefore, failures: input.confinementFailures }
}

export async function finishRun(input: TerminalInput): Promise<TerminalResult> {
  let {
    timer,
    checkpointTimer,
    resourceObserver,
    proc,
    askLoopback,
    claim,
    writesJob,
    worktree,
    failureKind,
    opts,
    removeIsolatedCwd,
    changes,
    provisionedMcpConfig,
    started,
    retargetDiagnostic,
    error,
    contract,
    status,
    contractObjects,
    vendorTerminatedStream,
    acceptedQuestions,
    requestedJob,
    checkReviewedCommit,
    output,
    confinementEvent,
    parsedReply,
    runProjectName,
    mcpConnection,
    declaredDeliverables,
    mcpSetupHeader,
    outPath,
    preConfinement,
    callerCwd,
    promptPath,
    exitCode,
    vendorTokens,
    costUsd,
    vendorUsage,
    effectiveModel,
    resolvedSession,
    name,
    artifactsPersisted,
    mcpRuling,
    workerEvents,
  } = input
  clearRunTimers(timer, checkpointTimer)
  const resourceUsage = resourceObserver?.stop() ?? null
  if (proc) {
    live.delete(proc)
    liveCheckpoints.delete(proc)
  }
  if (proc?.pid && proc.pid !== process.pid) await terminateProcessGroup(proc.pid, { direct: proc })
  if (askLoopback) await askLoopback.close()
  await resetSandbox()
  mcpSetupHeader = terminalOperationalHeader(input, mcpSetupHeader)
  const startedAt = db()
    .query('SELECT started_at, head_commit FROM run WHERE record_id=?')
    .get(claim.id) as { started_at: string; head_commit: string | null } | null
  const confinement = terminalConfinementSnapshots(input)
  // Remove the input-free directory after readSession can derive any transcript location from cwd.
  removeIsolatedCwd?.()
  /**
   * The diff is read EVEN WHEN THE RUN FAILED, and that is the point.
   *
   * A worker that timed out or crashed half way through an implementation has
   * left the most interesting artifact this system produces: a partial change
   * set showing exactly how far it got. Reading it only on success would
   * discard the evidence precisely where it is most useful, and would make a
   * timeout indistinguishable from a run that did nothing.
   *
   * Wrapped, because a diff that cannot be read must not turn a completed run
   * into a failed one — the agent's work is already done by this point, and
   * the row has to be written whatever git says.
   */
  if (worktree) {
    try {
      changes = provisionedMcpConfig
        ? provisionedMcpConfig.measure(() => changesIn(worktree))
        : changesIn(worktree)
    } catch (e) {
      changes = null
      console.error(`orch: could not read the diff for run ${claim.id}: ${e}`)
    }
  }
  const turnChanged = terminalTurnChanged({
    database: db(),
    runId: claim.id,
    writingJob: writesJob,
    worktreePath: worktree?.path ?? null,
    measurementScope: provisionedMcpConfig,
  })
  if (confinement.before.length && !confinement.failures.length) {
    confinementEvent = classifyCheckoutChanges({
      before: confinement.before,
      after: confinement.after.snapshots,
      removedCaller: confinement.after.removedCaller,
      ownDiffPaths: changes?.files ?? [],
      chainRoot: startedAt?.head_commit ?? null,
      database: db(),
      startedAt: startedAt?.started_at ?? new Date(started).toISOString(),
      removal: confinement.after.removal,
    })
  }
  if (retargetDiagnostic) error = error ? `${error}\n${retargetDiagnostic}` : retargetDiagnostic
  const finalization = finalizeWorkerReply({
    reply: contract,
    measuredFiles: changes?.files ?? null,
    turnChanged,
    status,
    failureKind,
    error,
    contractObjects,
  })
  ;({ status, failureKind, error } = finalization)
  const vendorTermination = applyVendorTermination({
    outcome: { status, failureKind, error },
    vendorTerminationError: vendorTerminatedStream ? errorTail(vendorTerminatedStream) : null,
    acceptedQuestions,
  })
  ;({ status, failureKind, error } = vendorTermination.outcome)
  acceptedQuestions = vendorTermination.acceptedQuestions
  const readerReply = isReaderJob(opts.job) ? (parsedReply as ReaderReply | null) : null
  const parsedReview =
    requestedJob.findings && output && (status === 'ok' || confinementEvent)
      ? (parsedReply as ReviewReply | null)
      : null
  const ownProject = runProjectName ? projectByName(runProjectName) : undefined
  const ownMcpServer =
    mcpConnection?.server ??
    (ownProject ? (ownProject.settings.mcpServer ?? ownProject.name) : undefined)
  const otherProjectMcpServers = new Set(
    projects()
      .map((project) => project.settings.mcpServer ?? project.name)
      .filter((server) => isNonPlatformMcpServer(server, ownMcpServer)),
  )
  const cleanReview =
    parsedReview && status === 'ok' && confinementEvent?.classification !== 'overlapping'
      ? cleanReviewEvidence(claim.id, parsedReview)
      : null
  const recordedHeadCommit = recordedReviewedHead(claim.id, checkReviewedCommit)
  const evidenceAssessment = assessEvidence(
    { status, error, failureKind },
    {
      findingsJob: Boolean(requestedJob.findings),
      outputPresent: Boolean(output),
      reviewReply: parsedReview,
      expectedReviewedCommit: recordedHeadCommit,
      confinementClassification: confinementEvent?.classification ?? null,
      cleanReview,
      otherProjectMcpServers,
      ownMcpServer,
      readerJob: isReaderJob(opts.job),
      declaredDeliverables,
      readerReply:
        status === 'ok' && isReaderJob(opts.job) && declaredDeliverables.length
          ? readerReply
          : null,
    },
  )
  status = evidenceAssessment.status
  error = evidenceAssessment.error
  failureKind = evidenceAssessment.failureKind
  const provenanceWrongProjectTool = evidenceAssessment.provenanceWrongProjectTool
  ;({ status, error, failureKind } = applyPrematureFinalFailure(
    { status, error, failureKind },
    terminalPrematureFinalRefusal({
      readerReply,
      parsedReview,
      contract,
      measuredFiles: changes?.files ?? null,
      workerEvents,
      acceptedQuestionCount: acceptedQuestions.length,
      exitCode,
    }),
  ))
  /**
   * Questions are deliberately inserted BEFORE the terminal row is written.
   * This is ordering, not a transaction: a lost terminal write can leave the
   * run reading `running` with an open question. That half-state is
   * recoverable because the escalation survived. The reverse — terminal
   * `asking` with nothing to answer — is not, and would sit in the inbox for
   * ever.
   *
   * Making the inserts atomic with the terminal write requires first making
   * questions recoverable from the terminal journal. `TerminalSnapshot`
   * carries no question payload, so reconciliation could otherwise restore
   * `asking` without its questions after a failed terminal transaction.
   */
  if (acceptedQuestions.length) {
    /**
     * A question asked through the LIVE channel and then repeated in the final
     * answer must not be recorded twice.
     *
     * That is the normal path when a live question times out: the tool tells
     * the worker to stop and report it, which is exactly what it then does.
     * Inserted again, the inbox shows the same question twice and `orch
     * answer` refuses a single ruling because it demands one per open
     * question — so the correct fallback made the run unanswerable.
     *
     * Matched on the question text, normalized, which is what the worker is
     * repeating verbatim from its own tool call.
     */
    const existingQuestionTexts = (
      db().query('SELECT question FROM question WHERE run_record_id = ?').all(claim.id) as {
        question: string
      }[]
    ).map((row) => row.question)
    const askedAt = nowIso()
    const awaitingOperatorAt = await initialQuestionWaitingAt(claim.id, askedAt)
    recordReplyQuestions({
      runId: claim.id,
      questions: questionsToInsert(existingQuestionTexts, acceptedQuestions),
      askedAt,
      awaitingOperatorAt,
    })
  }

  if (mcpSetupHeader) {
    output = output ? `${mcpSetupHeader}\n\n${output}` : mcpSetupHeader
    writeFileSync(outPath, output)
  }

  const confinementPrecedence = applyConfinementPrecedence({
    outcome: { status, failureKind, error },
    preConfinement,
    confinementUnverifiedError: confinement.failures.length
      ? confinementUnverifiedError(confinement.failures)
      : null,
    overlappingError:
      confinementEvent?.classification === 'overlapping'
        ? overlappingError(confinementEvent)
        : null,
  })
  ;({ status, failureKind, error } = confinementPrecedence.outcome)
  preConfinement = confinementPrecedence.preConfinement

  ;({ status, error, failureKind } = applyRequiredMcpFailure(
    { status, error, failureKind },
    mcpRuling,
  ))
  try {
    const declared = (contract?.blockers ?? []).map((b) => ({
      what: b.what,
      why: b.why,
      impact: b.impact ?? null,
    }))
    insertBlockerRows(claim.id, blockersToRecord({ declared, output }), nowIso())
  } catch (e) {
    // Never let recording a blocker fail a run that otherwise succeeded.
    console.error(`orch: could not record blockers for run ${claim.id}: ${e}`)
  }
  const testOutcome = writesJob
    ? observedTestOutcome(db(), claim.id, contract?.tests ?? null)
    : null
  const terminalSnapshot: TerminalSnapshot = {
    status,
    error,
    failureKind,
    output,
    outputPath: outPath,
    promptPath,
    exitCode,
    latencyMs: Date.now() - started,
    ...terminalUsageSnapshot(vendorTokens, input.callUsage, costUsd, vendorUsage, name),
    model: effectiveModel,
    vendorSession: resolvedSession,
    preConfinement,
    confinement: confinementEvent ? JSON.stringify(confinementEvent) : null,
    filesChanged: writesJob ? (changes?.files.length ?? null) : null,
    changedPaths: writesJob && changes ? JSON.stringify(changes.files) : null,
    linesAdded: writesJob ? (changes?.insertions ?? null) : null,
    linesRemoved: writesJob ? (changes?.deletions ?? null) : null,
    testsRan: testOutcome ? nullableBooleanColumn(testOutcome.ran) : null,
    testsPassed: testOutcome?.passed == null ? null : testOutcome.passed ? 1 : 0,
    testsClaimDisagrees: testOutcome ? (testOutcome.claimDisagrees ? 1 : 0) : null,
    deviations: writesJob ? (contract?.deviations?.length ?? null) : null,
    escalations: writesJob ? acceptedQuestions.length : null,
  }
  persistTerminalSnapshot(claim.id, terminalSnapshot)
  const reviewProvenance = parsedReview ? JSON.stringify(parsedReview.provenance) : null
  const provenanceSilent = reviewHidesGap(parsedReview, input, provenanceWrongProjectTool)
  const localMachineId = machineId()
  const writeTerminalRow = () =>
    writeTransaction(() => {
      const finishedAt = nowIso()
      db()
        .query(
          `UPDATE run SET latency_ms=?, exit_code=?, output_bytes=?, output_path=?, prompt_path=?,
                        vendor_tokens=?, model_calls=?, peak_call_tokens=?, vendor_cost_usd=?, vendor_input_tokens=?, vendor_output_tokens=?,
                        vendor_estimated_cost_usd=?, vendor_cost_source=?, model=COALESCE(?, model),
                        status=CASE WHEN status='stopped' THEN status ELSE ? END,
                        error=CASE WHEN status='stopped' THEN error ELSE ? END,
                        failure_kind=CASE WHEN status='stopped' THEN failure_kind ELSE ? END,
                        host_wait_since=NULL,
                        vendor_session=COALESCE(?, vendor_session), pre_confinement=?, confinement=?,
                        review_provenance=?, provenance_status=?,
                        unreconciled=0 WHERE record_id=?`,
        )
        .run(
          Date.now() - started,
          input.processless ? null : exitCode,
          new TextEncoder().encode(output).byteLength,
          input.processless ? null : outPath,
          promptPath,
          vendorTokens,
          input.callUsage?.modelCalls ?? null,
          input.callUsage?.peakCallTokens ?? null,
          costUsd,
          ...runUsageColumnValues(runUsageColumns(vendorUsage, AGENTS[name]?.billing)),
          effectiveModel,
          status,
          error,
          failureKind,
          resolvedSession,
          preConfinement,
          confinementEvent ? JSON.stringify(confinementEvent) : null,
          reviewProvenance,
          provenanceSilent ? 'silent' : null,
          claim.id,
        )

      writeOperationalState(input, resourceUsage, failureKind, name)
      recordTerminalMcpEvidence(db(), claim.id, mcpRuling)
      /**
       * The facts, recorded without anyone's opinion.
       *
       * Half of them are MEASURED (what the diff actually contains) and half are
       * CLAIMED (what the worker says about its own tests and deviations), and
       * they are stored side by side deliberately: the interesting signal is
       * where the two disagree. A worker reporting `tests.passed` beside a diff
       * that touches no test file has told you something, and no verdict is
       * needed to see it.
       */
      if (writesJob) {
        db()
          .query(
            `UPDATE run SET files_changed=?, changed_paths=?, lines_added=?, lines_removed=?,
                          tests_ran=?, tests_passed=?, tests_claim_disagrees=?, deviations=?, escalations=?
             WHERE record_id=?`,
          )
          .run(
            changes?.files.length ?? null,
            changes ? JSON.stringify(changes.files) : null,
            changes?.insertions ?? null,
            changes?.deletions ?? null,
            nullableBooleanColumn(testOutcome!.ran),
            testOutcome!.passed == null ? null : testOutcome!.passed ? 1 : 0,
            testOutcome!.claimDisagrees ? 1 : 0,
            contract?.deviations?.length ?? null,
            acceptedQuestions.length,
            claim.id,
          )
      }

      /**
       * THE ROOT CARRIES THE CHAIN'S OUTCOME. This is the line that makes a
       * multi-turn conversation one unit of work rather than three.
       *
       * Without it the arithmetic goes wrong in both directions at once. A chain
       * that ends well is root=`blocked` plus child=`ok`, so nothing is ever
       * offered for scoring — the root is not `ok` and the child is excluded from
       * evidence — and an implementation that succeeded would teach the router
       * nothing. Meanwhile the blocked root would sit in the inbox for ever,
       * still looking like a question nobody answered.
       *
       * The child terminal write and this roll-up share one transaction, so the
       * root can only inherit the terminal state written immediately above.
       * Every existing query therefore keeps working untouched: one row per unit
       * of work, holding where that work has got to, with the children recording
       * what each turn cost.
       */
      const identity = claimIdentity(opts.resume)
      // A resumed turn that stopped to ask reopens the conversation: the root
      // goes back to asking with no failure kind, because the chain has not
      // ended. Terminal questions close before resolution so a non-failover
      // failure can roll up instead of leaving an asking root with nothing to
      // answer.
      finalizeTerminalChain(db(), {
        runId: claim.id,
        parentRunId: identity.parent_run_record_id,
        status,
        failureKind,
        error,
        record: [localMachineId, finishedAt],
      })
      // A parsed findings reply is the review event. Capture it in the same
      // terminal transaction so a successful lens cannot exist in the gap
      // between "ran" and "recorded". Probe traffic is calibration and is not
      // recorded. Manual `bottega review record` remains the recovery path for
      // historical or otherwise uncaptured outputs.
      recordTerminalReviewEvidence(db(), {
        runId: identity.parent_run_record_id ?? claim.id,
        parsedReview,
        status,
        failureKind,
      })
      enqueueRunRecord(db(), claim.id, localMachineId, finishedAt)
    })
  try {
    writeTerminalRow()
  } catch (terminalError) {
    const detail = terminalError instanceof Error ? terminalError.message : String(terminalError)
    try {
      writeTerminalRow()
    } catch (retryError) {
      const retry = retryError instanceof Error ? retryError.message : String(retryError)
      try {
        db()
          .query(
            `UPDATE run SET unreconciled=1, error=? WHERE record_id=? AND status IN ('running','asking')`,
          )
          .run(
            `unreconciled: reply at ${runTerminalReplyPath(claim.id)}; ` +
              `cleared by: ${PLATFORM_SLUG} run reconcile ${claim.id}  (${retry})`,
            claim.id,
          )
      } catch {
        /* the snapshot is on disk; the row write is what failed */
      }
      console.error(`orch: run ${claim.id} left unreconciled: ${detail}`)
    }
  }
  const recorded = db().query(TERMINAL_STATUS_SQL).get(claim.id) as {
    status: string
    failure_kind: string | null
  } | null
  if (!recorded) {
    throw new Error(`run ${claim.id} disappeared before terminalisation`)
  }
  teardownTerminalRunResources(db(), claim.id)
  if (recorded.failure_kind === 'quota' || recorded.failure_kind === 'timeout') {
    tryWriteContention({
      resourceKind: 'vendor',
      resourceKey: name,
      eventKind: recorded.failure_kind === 'quota' ? 'refusal' : 'timeout',
      durationMs: Date.now() - started,
      cause: error,
      runId: claim.id,
    })
  } else if (
    recorded?.failure_kind === 'escaped' ||
    recorded?.failure_kind === 'confinement_unverified'
  ) {
    const event = confinementEvent
    tryWriteContention({
      resourceKind: 'main_checkout',
      resourceKey: event?.checkout ?? confinement.failures[0]?.path ?? callerCwd,
      eventKind: 'invalidation',
      cause: error,
      runId: claim.id,
    })
  }

  try {
    persistTerminalArtifacts(claim.id, readerReply, worktree, changes)
  } catch (e) {
    artifactsPersisted = false
    const persistenceError = `artifact persistence failed for ${runArtifactsDir(claim.id)}: ${String((e as Error)?.message ?? e)}`
    ;({ status, error, failureKind } = artifactPersistenceOutcome({
      status,
      error,
      failureKind,
      persistenceError,
    }))
    recordArtifactPersistenceFailure(db(), {
      runId: claim.id,
      parentRunId: claimIdentity(opts.resume).parent_run_record_id,
      error,
      machineId: localMachineId,
      finishedAt: nowIso(),
    })
    teardownTerminalRunResources(db(), claim.id)
    console.error(`orch: ${error}`)
  }

  return {
    status,
    error,
    failureKind,
    changes,
    output,
    acceptedQuestions,
    confinementEvent,
    preConfinement,
    artifactsPersisted,
  }
}
