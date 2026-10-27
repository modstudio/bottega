// concern: run-live
/**
 * Knows spawning, watching, and classifying one live vendor process. Must not
 * know run claiming, terminalisation, failover, dispatch surfaces, or the CLI.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { projectCodeGitEnv } from '../../../shared/git.ts'
import type { Agent } from '../agent/agents.ts'
import { type AskLoopback, startAskLoopback } from '../ask/ask.ts'
import { recordAskExpected } from '../ask/ask-lifecycle.ts'
import { startWorkerNoteBroker, type WorkerNoteBroker } from '../ask/worker-note-broker.ts'
import { markRunBoardNoticesDelivered } from '../board/board-delivery.ts'
import {
  isAsking,
  REPLY_FILE_NAME,
  type ReplyDialect,
  realQuestions,
  type WorkerReply,
} from '../contract/contract.ts'
import { db, nowIso } from '../database/db.ts'
import { recordRunWarning, type StreamEvent, teeTransportEvents } from '../events.ts'
import { type classify, hasVendorTerminationMarker } from '../failure/failure.ts'
import { contentTree, gitContext, reviewChangedPaths } from '../git/git-environment.ts'
import { idlePollMs, terminateProcessGroup } from '../idle-kill.ts'
import { type Job, jobIdleKillMs } from '../jobs/jobs.ts'
import { deriveLiveOutcome } from '../live-outcome.ts'
import { receiptWorkerMessages, unreadWorkerMessages } from '../mailbox/mailbox.ts'
import { deferredWorkerMessageNotice } from '../mailbox/mailbox-notice.ts'
import { decideOutcome, type OutcomeStatus, schemaEnvelopeContractError } from '../outcome.ts'
import {
  observeRunProcessTree,
  type ProcessSample,
  type RunResourceObserver,
  sampleProcesses,
} from '../process-resource-sampler.ts'
import { processStartTime } from '../project/project-lock.ts'
import type { CodexMcpServer } from '../sandbox/codex-mcp-scope.ts'
import type { ProjectMcpSelection } from '../sandbox/project-mcp-scope.ts'
import type { SandboxSelection } from '../sandbox/sandbox.ts'
import {
  EMPTY_VENDOR_USAGE,
  type TransportHandle,
  type TransportName,
  type TransportResult,
  type TransportStartOpts,
  transportFor,
  type VendorUsage,
} from '../transport/transport.ts'
import type { Worktree } from '../worktree/worktree-types.ts'
import {
  type CheckpointContainment,
  checkpointRun,
  checkpointSkippedLine,
  DEFAULT_CHECKPOINT_MINUTES,
} from './checkpoint.ts'
import { createCheckpointSchedule } from './checkpoint-schedule.ts'
import { prepareLaterRunBoardPrompt } from './run-board-prompt.ts'
import { foldRunCallUsage, type RunCallUsage } from './run-call-usage.ts'
import { startRunAfterHostCapacity, waitForRunHostCapacity } from './run-host-capacity.ts'
import { type IdleKillState, idleSnapshotObserver, performIdleKill } from './run-idle-kill.ts'
import { childEnv, errorTail, live, liveCheckpoints } from './run-process.ts'
import { collectReplySource, replyContract } from './run-reply-source.ts'
import { checkpointRoot, resumeFacts } from './run-resume-kind.ts'
import { firstThrottleObserver, throttleReplyError } from './run-throttle.ts'
import {
  appendGateExclusionToTimeoutError,
  currentExcludedGateMs,
  decideRunWallDeadline,
  excludedGateIntervalMs,
  gateExclusionNoteSuffix,
  type RunWallDeadlineFacts,
} from './run-wall-deadline.ts'
import {
  type BrokerConfinement,
  closeWorkerExecutionBrokers,
  startWorkerExecutionBrokers,
  type WorkerExecutionBrokers,
} from './run-worker-brokers.ts'

function readReplyFile(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

function outputCeilingReached(
  reply: { text: string; stopReason?: string | null } | null,
  ceilingReason: string | null,
): boolean {
  return Boolean(
    reply && !reply.text.trim() && ceilingReason !== null && reply.stopReason === ceilingReason,
  )
}

async function recordInitialDeliveries(
  runId: string,
  messageIds: string[],
  noticeIds: Array<number | string>,
): Promise<void> {
  receiptWorkerMessages(runId, messageIds)
  await markRunBoardNoticesDelivered(runId, noticeIds)
}

function liveChildEnv(
  agent: Agent,
  runRecordId: string,
  runToken: string,
  extra: Record<string, string>,
  includeStore: boolean,
  runNumber: number,
  jobContextTokens: number | null,
  promptBytes: number | null,
): Record<string, string> {
  const environment = childEnv(
    agent,
    runRecordId,
    runToken,
    extra,
    includeStore,
    runNumber,
    {},
    jobContextTokens,
    promptBytes,
  )
  return includeStore ? (projectCodeGitEnv(environment) as Record<string, string>) : environment
}

/** The run-specific extras merged over the agent's own launch environment. */
function liveLaunchExtra(
  launchEnvironment: Record<string, string>,
  scratchDir: string,
  askLoopback: AskLoopback | null,
): Record<string, string> {
  return {
    ...launchEnvironment,
    BOTTEGA_SCRATCH: scratchDir,
    ...(askLoopback ? { BOTTEGA_ASK_URL: askLoopback.url } : {}),
  }
}

function classifiedReplyFileError(
  ruling: ReturnType<typeof collectReplySource>,
  schema: unknown,
): string | null {
  return schemaEnvelopeContractError(ruling.replyFileError, ruling.replyFileValue, schema)
}

function recordConfiguredAsk(input: {
  runId: string
  sandbox: SandboxSelection['sandbox']
  transport: ReturnType<typeof transportFor>
  startOpts: TransportStartOpts
}): void {
  try {
    const configured = input.transport.configuredAsk(input.startOpts)
    if (configured) {
      recordAskExpected(input.runId, input.sandbox === 'srt' ? 'srt' : 'host', configured)
    }
  } catch {
    // Configuration evidence is best effort and must never prevent launch.
  }
}

function brokerConfinement(
  input: Pick<LiveInput, 'writingAcp'>,
  profile: SandboxSelection['profile'],
): BrokerConfinement {
  if (!input.writingAcp) return { kind: 'host' }
  if (!profile) throw new Error('writing ACP broker confinement requires an srt profile')
  return { kind: 'srt', profile }
}

function endpointAsk(loopback: AskLoopback | null) {
  return loopback?.kind === 'endpoint'
    ? { kind: 'endpoint' as const, url: loopback.url }
    : undefined
}

async function closeLiveBrokers(
  execution: WorkerExecutionBrokers | null,
  note: WorkerNoteBroker | null,
): Promise<void> {
  await closeWorkerExecutionBrokers(execution)
  await closeWorkerNoteBroker(note)
}

/** A missing named reply is observable even when its final-message fallback is valid. */
export function replyFileFallbackError(
  replyFile: string,
  present: boolean,
  error: string | null,
): string | null {
  if (present) return error
  const notice = `${REPLY_FILE_NAME} missing at ${replyFile}; used final-message fallback`
  return error ? `${error}\n${notice}` : notice
}

type LiveOptions = {
  resume?: {
    kind: 'continue' | 'fresh-session' | 'retry-root'
    parent: string
    turn: number
    session?: string
  }
  model?: string
  schemaPath?: string
  job: string
}

async function startAfterHostCapacity(input: {
  repoJob: boolean
  claim: { id: string }
  opts: Pick<LiveOptions, 'resume'>
  transport: ReturnType<typeof transportFor>
  startOpts: TransportStartOpts
}): Promise<TransportHandle> {
  const runId = input.claim.id
  const result = await startRunAfterHostCapacity({
    wait: () =>
      input.repoJob
        ? waitForRunHostCapacity({
            database: db(),
            runId,
            existingChain: input.opts.resume !== undefined,
          })
        : Promise.resolve(null),
    isRunning: () =>
      (
        db().query('SELECT status FROM run WHERE record_id=?').get(runId) as {
          status: string
        } | null
      )?.status === 'running',
    spawn: () =>
      input.opts.resume?.session && input.opts.resume.kind === 'continue'
        ? input.transport.resume({
            ...input.startOpts,
            session: input.opts.resume.session,
            resume: true,
          })
        : input.transport.start(input.startOpts),
    stop: (handle) => input.transport.cancel(handle),
  })
  const hostWait = result.wait
  if (hostWait?.drainingFor) {
    throw new Error(
      `run stopped for migration drain ${hostWait.drainingFor}; re-dispatch after ${PLATFORM_SLUG} machine update finishes`,
    )
  }
  if (hostWait?.boundReached) {
    const message = `host capacity wait bound reached after ${hostWait.waitedMs}ms; starting run`
    console.error(`orch: ${message}`)
    recordRunWarning(runId, message)
  }
  if (!result.handle) throw new Error('run stopped while waiting for host capacity')
  return result.handle
}

const warnForRun = (runId: string) => (message: string) => recordRunWarning(runId, message)

async function runAskLoopback(
  existing: AskLoopback | null,
  sandbox: SandboxSelection['sandbox'],
  runId: string,
  token: string,
): Promise<AskLoopback | null> {
  if (existing || sandbox !== 'srt') return existing
  return startAskLoopback(runId, token)
}

export type LiveInput = {
  repoJob: boolean
  name: string
  worktree: Worktree | null
  claim: { id: string; recordId: string; number: number }
  provisionedMcpConfig: { measure<T>(operation: () => T): T } | null
  reviewTarget: { branch: string; commit: string; base: string } | null
  sandboxSelection: SandboxSelection
  runToken: string
  transportName: TransportName
  a: Agent
  cwd: string
  prompt: string
  outPath: string
  vendorSession: string | null
  schemaPath: string | undefined
  originalSchemaPath: string | undefined
  opts: LiveOptions
  sandboxEnvironment: Record<string, string>
  writes: boolean
  usingMcp: boolean
  mcpServerName: string | null
  codexMcpScope: { servers: Record<string, CodexMcpServer> } | null
  projectMcpSelection: ProjectMcpSelection | null
  mcpTrustGranted: boolean
  writableRoots: string[]
  gitConfigEnvironment: Record<string, string> | undefined
  runtimeDir: string
  recipeEnvironment: Record<string, string>
  launchEnvironment: Record<string, string>
  scratchDir: string
  writesJob: boolean
  codexSandbox: {
    sandbox: 'read-only' | 'workspace-write'
    workspaceWriteNetworkAccess: boolean
  }
  launchKey: string | null
  requestedJob: Job
  boundMs: number
  started: number
  textReplyContract: boolean
  resolvedDialect: ReplyDialect
  mcpSetupHeader: string | null
  initialBoardNoticeIds: Array<number | string>
  throttleConcurrency: () => number
  askLoopback: AskLoopback | null
  writingAcp: boolean
  checkpointContainment: CheckpointContainment
}

export type LiveResult = {
  proc: { pid?: number | null; kill(sig?: number | string): void } | null
  timer: ReturnType<typeof setTimeout> | null
  checkpointTimer: ReturnType<typeof setInterval> | null
  resourceObserver: RunResourceObserver | null
  timedOut: boolean
  idleKilled: boolean
  idleKillError: string | null
  idleUnkillable: boolean
  idleTreePids: number[]
  idleTreePgid: number | null
  exitCode: number
  output: string
  vendorTokens: number | null
  callUsage: RunCallUsage | null
  costUsd: number | null
  vendorUsage: VendorUsage
  resolvedSession: string | null
  effectiveModel: string | null
  replyFileError: string | null
  replyFilePresent: boolean
  contract: WorkerReply | null
  contractObjects: number
  acceptedQuestions: ReturnType<typeof realQuestions>
  status: OutcomeStatus
  error: string | null
  failureKind: ReturnType<typeof classify> | null
  artifactsPersisted: boolean
  preConfinement: string | null
  vendorTerminatedStream: string | null
  askLoopback: AskLoopback | null
  mcpSetupHeader: string | null
  workerEvents: StreamEvent[]
}

function vendorProcessSample(pid: number | null): ProcessSample | undefined {
  return pid && pid > 1 ? sampleProcesses().find((row) => row.pid === pid) : undefined
}

function liveCheckpointSchedule(input: {
  writesJob: boolean
  worktree: Worktree | null
  runId: string
  taskKey: string | null
  scratchDir: string
  guardEnvironment: NodeJS.ProcessEnv
  containment: CheckpointContainment
}) {
  return createCheckpointSchedule((trigger) => {
    if (!input.writesJob || !input.worktree) return null
    const result = checkpointRun({
      database: db(),
      runId: input.runId,
      worktree: input.worktree.path,
      branch: input.worktree.branch,
      taskKey: input.taskKey,
      scratchDir: input.scratchDir,
      guardEnvironment: input.guardEnvironment,
      containment: input.containment,
      final: trigger === 'limit',
    })
    if (result.error) console.error(`orch: run ${input.runId} checkpoint failed: ${result.error}`)
    const skipped = checkpointSkippedLine(result, {
      runId: input.runId,
      final: trigger === 'limit',
    })
    if (skipped) console.error(skipped)
    return result
  })
}

type ConfiguredAsk = Parameters<typeof recordConfiguredAsk>[0]

function recordRunAsk(
  runId: string,
  sandbox: ConfiguredAsk['sandbox'],
  transport: ConfiguredAsk['transport'],
  startOpts: ConfiguredAsk['startOpts'],
): void {
  recordConfiguredAsk({ runId, sandbox, transport, startOpts })
}

function applyRunWallDeadline(input: {
  currentTimer: ReturnType<typeof setTimeout> | null
  facts: RunWallDeadlineFacts
  expire: () => void
  rearm: () => void
}): ReturnType<typeof setTimeout> | null {
  if (input.currentTimer) clearTimeout(input.currentTimer)
  const decision = decideRunWallDeadline(input.facts)
  if (decision.expireNow) {
    input.expire()
    return null
  }
  return setTimeout(input.rearm, decision.delayMs)
}

async function closeWorkerNoteBroker(broker: WorkerNoteBroker | null): Promise<void> {
  if (broker) await broker.close()
}

function teeLiveTransport(
  input: LiveInput,
  handle: TransportHandle,
  observe: (event: StreamEvent) => void,
  callUsage: { value: RunCallUsage | null },
) {
  return teeTransportEvents(handle.events(), input.claim.id, input.throttleConcurrency, (event) => {
    observe(event)
    callUsage.value = foldRunCallUsage(callUsage.value, event)
  })
}

function runUsageResult(
  vendorTokens: number | null,
  callUsage: RunCallUsage | null,
  costUsd: number | null,
  vendorUsage: VendorUsage,
) {
  return { vendorTokens, callUsage, costUsd, vendorUsage }
}

export async function runLive(input: LiveInput): Promise<LiveResult> {
  let {
    repoJob,
    name,
    worktree,
    claim,
    provisionedMcpConfig,
    reviewTarget,
    sandboxSelection,
    runToken,
    transportName,
    a,
    cwd,
    prompt,
    outPath,
    vendorSession,
    schemaPath,
    originalSchemaPath,
    opts,
    sandboxEnvironment,
    writes,
    usingMcp,
    mcpServerName,
    codexMcpScope,
    mcpTrustGranted,
    writableRoots,
    gitConfigEnvironment,
    runtimeDir,
    recipeEnvironment,
    launchEnvironment,
    scratchDir,
    writesJob,
    codexSandbox,
    launchKey,
    requestedJob,
    boundMs,
    started,
    textReplyContract,
    resolvedDialect,
    mcpSetupHeader,
    initialBoardNoticeIds,
  } = input
  let proc: { pid?: number | null; kill(sig?: number | string): void } | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let checkpointTimer: ReturnType<typeof setInterval> | null = null
  let resourceObserver: RunResourceObserver | null = null
  let timedOut = false
  const idleKill: IdleKillState = {
    killed: false,
    error: null,
    unkillable: false,
    treePids: [],
    treePgid: null,
  }
  let exitCode = -1
  let output = ''
  let vendorTokens: number | null = null,
    callUsage: { value: RunCallUsage | null } = { value: null }
  let costUsd: number | null = null
  let vendorUsage = EMPTY_VENDOR_USAGE
  let resolvedSession: string | null = vendorSession
  let effectiveModel: string | null = null
  let replyFileError: string | null = null
  let replyFilePresent = false
  let contract: WorkerReply | null = null
  let contractObjects = 0
  let acceptedQuestions: ReturnType<typeof realQuestions> = []
  let status: OutcomeStatus = 'failed'
  let error: string | null = null
  let failureKind: ReturnType<typeof classify> | null = null
  const preConfinement: string | null = null
  let vendorTerminatedStream: string | null = null
  let askLoopback: AskLoopback | null = input.askLoopback
  let executionBrokers: WorkerExecutionBrokers | null = null
  let noteBroker: WorkerNoteBroker | null = null
  let workerEvents: StreamEvent[] = []
  let wallArmedAtMs: number | null = null
  let accruedGateMs = 0
  let gateStartedAtMs: number | null = null
  let excludedGateMsAtTimeout = 0
  let rearmWallDeadline = () => {}
  const checkpointSchedule = liveCheckpointSchedule({
    writesJob,
    worktree,
    runId: claim.id,
    taskKey: launchKey,
    scratchDir,
    guardEnvironment: gitConfigEnvironment ?? {},
    containment: input.checkpointContainment,
  })
  try {
    if (repoJob) {
      if (!worktree) throw new Error(`repository run ${claim.id} has no worktree to measure`)
      const inputTree = provisionedMcpConfig
        ? provisionedMcpConfig.measure(() => contentTree(worktree.path))
        : contentTree(worktree.path)
      const headCommit = gitContext(worktree.path, 'rev-parse', '--verify', 'HEAD^{commit}')
      const changedPaths = reviewTarget
        ? reviewChangedPaths(worktree.path, reviewTarget.base, inputTree)
        : null
      const measured = db()
        .query('UPDATE run SET input_tree=?, head_commit=?, changed_paths=? WHERE record_id=?')
        .run(inputTree, headCommit, changedPaths ? JSON.stringify(changedPaths) : null, claim.id)
      if (measured.changes !== 1) throw new Error(`run ${claim.id} could not record its input tree`)
    }
    askLoopback = await runAskLoopback(askLoopback, sandboxSelection.sandbox, claim.id, runToken)
    executionBrokers = startWorkerExecutionBrokers({
      repoJob,
      writesRepo: writesJob,
      worktree,
      runId: claim.id,
      scratchDir,
      environment: { ...(gitConfigEnvironment ?? {}), ...recipeEnvironment },
      confinement: brokerConfinement(input, sandboxSelection.profile),
      onExecutionStart: checkpointSchedule.executionStarted,
      onExecutionFinish: checkpointSchedule.executionFinished,
      onGateStart: (at) => {
        gateStartedAtMs = Date.parse(at)
        rearmWallDeadline()
      },
      onGateFinish: (at) => {
        accruedGateMs += excludedGateIntervalMs(wallArmedAtMs, gateStartedAtMs, Date.parse(at))
        gateStartedAtMs = null
        rearmWallDeadline()
      },
    })
    noteBroker = startWorkerNoteBroker(claim.id)
    const t = transportFor(transportName)
    const checkpointMessages = unreadWorkerMessages(claim.id)
    const boardDelivery = await prepareLaterRunBoardPrompt(
      claim.id,
      Boolean(opts.resume),
      checkpointMessages,
      prompt,
    )
    prompt = boardDelivery.prompt
    const startOpts: TransportStartOpts = {
      agent: a,
      cwd,
      prompt,
      outPath,
      // A fresh Grok CLI id is not resumable; ACP would issue session/load for a nonexistent session.
      session:
        transportName === 'acp' && opts.resume?.kind === 'continue'
          ? opts.resume?.session
          : (vendorSession ?? undefined),
      schemaPath: schemaPath ?? undefined,
      model: opts.model ?? a.model,
      modelExplicit: opts.model !== undefined,
      home: sandboxEnvironment.HOME,
      startedAt: started,
      write: writes,
      writingAcp: input.writingAcp,
      ask: endpointAsk(askLoopback),
      sandbox: codexSandbox.sandbox,
      sandboxWorkspaceWriteNetworkAccess: codexSandbox.workspaceWriteNetworkAccess,
      mcp: usingMcp,
      mcpServer: mcpServerName ?? undefined,
      projectServers: codexMcpScope?.servers,
      projectMcpSelection: input.projectMcpSelection,
      trustCwd: mcpTrustGranted ? cwd : undefined,
      writableRoots,
      gitConfigEnvironment,
      recipeEnvironment,
      srt: sandboxSelection.profile ? { profile: sandboxSelection.profile, runtimeDir } : undefined,
      resume: resumeFacts(opts.resume?.kind ?? null, claim.id, opts.resume?.parent ?? null)
        .carriesVendorSession,
      env: liveChildEnv(
        a,
        claim.recordId,
        runToken,
        liveLaunchExtra(launchEnvironment, scratchDir, askLoopback),
        repoJob,
        claim.number,
        requestedJob.contextTokens,
        // The composed prompt's own size, measured where the prompt is final:
        // some jobs' material arrives inline here (a `summarize` prompt carries
        // its document) rather than in the working set the job declares.
        Buffer.byteLength(prompt, 'utf8'),
      ),
      onWarning: warnForRun(claim.id),
    }
    recordRunAsk(claim.id, sandboxSelection.sandbox, t, startOpts)
    const handle = await startAfterHostCapacity({
      repoJob,
      claim,
      opts,
      transport: t,
      startOpts,
    })
    proc = handle
    live.add(handle)
    effectiveModel = handle.effectiveModel ?? null
    if (effectiveModel)
      db().query('UPDATE run SET model=? WHERE record_id=?').run(effectiveModel, claim.id)
    // The vendor pid stays the worker's while output and questions are finalized;
    // testing it then would mark a still-finalizing run stale.
    //
    // Recorded HERE, before the wait, not after it. Written afterwards it is
    // always the pid of a process that has already exited.
    // Idle is silence of the VENDOR, not of orchestrator's own setup. last_event_at
    // and the reclaimed-wall clock both start here so a slow worktree cut
    // cannot burn either budget.
    const vendorStartedAt = Date.now()
    const vendorPid = handle.pid ?? null
    const vendorSample = vendorProcessSample(vendorPid)
    const vendorPgid = vendorSample && vendorSample.pgid > 1 ? vendorSample.pgid : null
    const vendorStartTime = vendorPid && vendorPid > 1 ? processStartTime(vendorPid) : null
    db()
      .query(
        `UPDATE run SET agent_pid=?, agent_pgid=?, agent_start_time=?, host_wait_since=NULL,
              last_event_at=COALESCE(last_event_at, ?) WHERE record_id=?`,
      )
      .run(vendorPid, vendorPgid, vendorStartTime, nowIso(), claim.id)
    if (writesJob) {
      checkpointTimer = setInterval(
        () => {
          checkpointSchedule.request('scheduled')
        },
        (requestedJob.checkpointMinutes ?? DEFAULT_CHECKPOINT_MINUTES) * 60_000,
      )
      if (worktree) {
        liveCheckpoints.set(handle, {
          runId: claim.id,
          rootId: checkpointRoot(opts.resume, claim.id),
          worktree: worktree.path,
          branch: worktree.branch,
          taskKey: launchKey,
          scratchDir,
          guardEnvironment: gitConfigEnvironment ?? {},
          containment: input.checkpointContainment,
        })
      }
    }
    // Two timeouts, composed, not one: the wall stays, and idle kill is the
    // second, shorter no-activity bound. Do not replace the wall.
    wallArmedAtMs = Date.now()
    const expireWall = () => {
      rearmWallDeadline = () => {}
      if (idleKill.killed) return
      excludedGateMsAtTimeout = currentExcludedGateMs(
        wallArmedAtMs!,
        accruedGateMs,
        gateStartedAtMs,
        Date.now(),
      )
      timedOut = true
      void t.cancel(handle)
      // Descendant-aware SIGTERM, bounded grace, then SIGKILL. A CLI that
      // ignores SIGTERM would otherwise keep the caller waiting for ever.
      void terminateProcessGroup(handle.pid ?? 0, { direct: handle })
    }
    rearmWallDeadline = () => {
      const nowMs = Date.now()
      timer = applyRunWallDeadline({
        currentTimer: timer,
        facts: {
          boundMs,
          armedAtMs: wallArmedAtMs!,
          accruedGateMs,
          gateStartedAtMs,
          nowMs,
        },
        expire: expireWall,
        rearm: rearmWallDeadline,
      })
    }
    rearmWallDeadline()
    let forceCollect: ((result: TransportResult) => void) | null = null
    const forcedCollect = new Promise<TransportResult>((resolve) => {
      forceCollect = resolve
    })
    resourceObserver = observeRunProcessTree(
      vendorPid,
      vendorStartTime,
      idlePollMs(jobIdleKillMs(opts.job, process.env, boundMs)),
      idleSnapshotObserver(
        claim.id,
        () => timedOut || idleKill.killed,
        (samples) =>
          performIdleKill({
            state: idleKill,
            runId: claim.id,
            job: opts.job,
            boundMs,
            vendorStartedAtMs: vendorStartedAt,
            timedOut,
            samples,
            handle,
            cancel: () => void t.cancel(handle),
            checkpoint: checkpointSchedule,
            checkpointRootId: checkpointRoot(opts.resume, claim.id),
            scratchDir,
            worktreePath: worktree?.path ?? null,
            forceCollect: (result) => forceCollect?.(result),
          }),
      ),
    )
    const throttle = firstThrottleObserver(() => void t.cancel(handle))
    const teeing = teeLiveTransport(input, handle, throttle.observe, callUsage)
    await t.prompt(handle, prompt)
    await recordInitialDeliveries(
      claim.id,
      checkpointMessages.map((message) => message.record_id),
      [...initialBoardNoticeIds, ...boardDelivery.notices.map((notice) => notice.id)],
    )
    const collected = await Promise.race([handle.collect(), forcedCollect])
    workerEvents = collected.events.filter(
      (event): event is StreamEvent =>
        event.kind === 'text' || event.kind === 'usage' || event.kind === 'tool',
    )
    await teeing.catch(() => {
      /* the live log is observation, never outcome */
    })
    const stdout = collected.stdout
    const stderr = collected.stderr
    // One derivation from the raw stream, carried through terminalisation.
    vendorTerminatedStream = [stdout, stderr].find(hasVendorTerminationMarker) ?? null
    exitCode = collected.exitCode
    const reply = collected.parsed
    const replyError = throttleReplyError(throttle.state.first, reply?.error, collected.error)
    const reachedOutputCeiling = outputCeilingReached(reply, a.outputCeilingStopReason)
    vendorTokens = collected.tokens
    costUsd = collected.costUsd
    vendorUsage = collected.vendorUsage
    effectiveModel = collected.effectiveModel ?? effectiveModel
    resolvedSession = collected.sessionId ?? vendorSession
    output = collected.output
    const replyFile = join(scratchDir, REPLY_FILE_NAME)
    const replyFileText = readReplyFile(replyFile)
    const replyContractKind = replyContract(opts.schemaPath, textReplyContract)
    const validationSchema =
      replyFileText !== null || replyContractKind === 'custom'
        ? JSON.parse(readFileSync(originalSchemaPath!, 'utf8'))
        : null
    const ruling = collectReplySource({
      replyFileText,
      contract: replyContractKind,
      fallbackText: output,
      dialect: resolvedDialect,
      schema: validationSchema,
    })
    output = ruling.output
    replyFileError = classifiedReplyFileError(ruling, validationSchema ?? resolvedDialect.schema)
    replyFilePresent = ruling.replyFilePresent
    if (ruling.rewriteOutputFile) writeFileSync(outPath, output)
    const transportQuestions = collected.asking
      ? collected.questions.map((item) => ({
          question: item.question,
          options: item.options ?? null,
          recommendation: item.recommendation ?? null,
          why: item.why,
        }))
      : []
    for (const event of collected.events) {
      if (event.kind !== 'permission') continue
      const line =
        `permission ${event.decision}: ${event.title}` +
        (event.toolKind ? ` (${event.toolKind})` : '')
      mcpSetupHeader = mcpSetupHeader ? `${mcpSetupHeader}\n${line}` : line
    }
    /**
     * A worker that stopped to ask is neither a success nor a failure.
     *
     * Read BEFORE the success/failure ladder below, because every branch of it
     * would get this wrong: exit 0 with a reply looks like `ok`, and recording
     * a blocked run as `ok` would put an unfinished implementation into the
     * evidence base as a completed one — and would score an agent for work it
     * has not done. `blocked` is its own terminal state precisely so routing
     * can decline to count it either way.
     */
    /**
     * Parsed from whatever the agent WROTE, not only from a clean exit.
     *
     * codex writes its final message to the `-o` file as it finishes, so a
     * reply can be complete and valid while the process is killed a moment
     * later — by a harness command timeout, by SIGTERM traveling down a
     * process group. Gating the parse on `exitCode === 0` threw that reply away
     * and recorded "reply did not match the worker contract" over a reply that
     * matched it perfectly, which is a misleading epitaph for work that was
     * actually done.
     *
     * A parsed contract does not by itself make the run `ok` — the ladder below
     * still decides that — but it means the finished work is in hand and the
     * error can say what really happened.
     */
    const undelivered = unreadWorkerMessages(claim.id)
    if (undelivered.length) {
      const remedy = deferredWorkerMessageNotice(
        undelivered[0]!.root_run_record_id,
        t.canInjectMidTurn,
      )
      const header = [
        `undelivered worker messages: ${undelivered.map((message) => message.number).join(', ')}`,
        remedy,
      ]
        .filter(Boolean)
        .join('\n')
      mcpSetupHeader = mcpSetupHeader ? `${mcpSetupHeader}\n${header}` : header
    }
    if (writesJob && output) {
      const parsed = resolvedDialect.parse(output)
      contract = parsed.reply as WorkerReply | null
      contractObjects = parsed.contractObjects
    }
    const questionsControlStatus = isAsking(contract) || contract?.status === 'done'
    acceptedQuestions = questionsControlStatus ? realQuestions(contract) : transportQuestions
    const derived = deriveLiveOutcome({
      writesJob,
      contractStatus: contract?.status ?? null,
      replyError,
      output,
      replyFilePresent,
      replyFileError,
      transportName,
      transportStatus: collected.status,
      transportStopReason: collected.stopReason,
      transportError: collected.error,
      transportFailureKind: collected.failureKind,
      collectedAsking: collected.asking,
      acceptedQuestions: acceptedQuestions.length > 0,
      idleKilled: idleKill.killed,
      idleKillError: idleKill.error,
      outputCeilingReached: reachedOutputCeiling,
      outputCeilingStopReason: reply?.stopReason ?? null,
      timedOut,
      stderr,
      stdout,
      exitCode,
      signal: collected.signal ?? null,
      sandbox: sandboxSelection.sandbox,
      boundMs,
      agentName: name,
    })
    error = appendGateExclusionToTimeoutError(
      replyFileFallbackError(replyFile, replyFilePresent, derived.error),
      timedOut,
      excludedGateMsAtTimeout,
    )
    if (idleKill.killed && derived.inputs.completedReply) {
      console.error(
        `orch: run ${claim.id} had already returned a complete reply when idle-killed. ` +
          `Recorded ${acceptedQuestions.length ? 'asking' : 'ok'}.`,
      )
    } else if (
      timedOut &&
      derived.inputs.completedReplyAtTimeout &&
      !idleKill.killed &&
      !derived.inputs.acpVendorStop &&
      !replyFileError &&
      !collected.asking &&
      !acceptedQuestions.length &&
      !reachedOutputCeiling
    ) {
      /**
       * IT FINISHED, AND THEN WE KILLED IT.
       *
       * A writing agent proves completion with its contract. A read-only
       * agent's answer IS its output, and completeness belongs to the later
       * delivery/quality judgment; requiring a writer-only contract here made
       * every read-only wall kill look like no answer even when substantial
       * work was already on disk.
       *
       * The writing case that first found this had completed fifteen files,
       * PHPStan and PHPUnit in Docker before our twenty-minute bound fired.
       * The read-only case produced a complete file-question answer before the
       * same kind of kill. Recording either as a timeout reads as "produced
       * nothing" and charges the agent for work it already delivered.
       *
       * The reply is on disk either way, so believe it. The kill is still
       * worth knowing about — the bound may be too short for this job — but it
       * is a note on a successful run, not a failure.
       */
      console.error(
        `orch: run ${claim.id} had already returned a complete reply when the ` +
          `${Math.round(boundMs / 60_000)}m bound killed it. Recorded ` +
          `${acceptedQuestions.length ? 'asking' : 'ok'}; the bound may be short` +
          gateExclusionNoteSuffix(excludedGateMsAtTimeout),
      )
    }
    ;({ status, failureKind } = decideOutcome(derived.inputs))
  } catch (e) {
    // Spawn refused, a pipe broke, the output file could not be written. The row
    // exists and must not be left claiming to run.
    status = 'failed'
    error = errorTail(proc ? String((e as Error)?.stack ?? e) : String((e as Error)?.message ?? e))
    failureKind = proc ? 'other' : 'harness'
  }
  rearmWallDeadline = () => {}
  clearTimeout(timer ?? undefined)
  timer = null
  await closeLiveBrokers(executionBrokers, noteBroker)
  return {
    proc,
    timer,
    checkpointTimer,
    resourceObserver,
    timedOut,
    idleKilled: idleKill.killed,
    idleKillError: idleKill.error,
    idleUnkillable: idleKill.unkillable,
    idleTreePids: idleKill.treePids,
    idleTreePgid: idleKill.treePgid,
    exitCode,
    output,
    ...runUsageResult(vendorTokens, callUsage.value, costUsd, vendorUsage),
    resolvedSession,
    effectiveModel,
    replyFileError,
    replyFilePresent,
    contract,
    contractObjects,
    acceptedQuestions,
    status,
    error,
    failureKind,
    artifactsPersisted: true,
    preConfinement,
    vendorTerminatedStream,
    askLoopback,
    mcpSetupHeader,
    workerEvents,
  }
}
