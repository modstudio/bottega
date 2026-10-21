// concern: run-live
/**
 * Knows spawning, watching, and classifying one live vendor process. Must not
 * know run claiming, terminalisation, failover, dispatch surfaces, or the CLI.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Agent } from '../agent/agents.ts'
import { type AskLoopback, startAskLoopback } from '../ask/ask.ts'
import { recordAskExpected } from '../ask/ask-lifecycle.ts'
import { startWorkerNoteBroker, type WorkerNoteBroker } from '../ask/worker-note-broker.ts'
import { markRunBoardNoticesDelivered } from '../board/board-delivery.ts'
import type { ConfinementEvent, FreezeFailure } from '../confinement/confinement.ts'
import {
  isAsking,
  REPLY_FILE_NAME,
  type ReplyDialect,
  realQuestions,
  TEXT_REPLY_SCHEMA,
  validatesSchema,
  type WorkerReply,
} from '../contract/contract.ts'
import { db, nowIso } from '../database/db.ts'
import {
  appendRunEvent,
  recordRunWarning,
  type StreamEvent,
  teeTransportEvents,
} from '../events.ts'
import { type classify, hasVendorTerminationMarker } from '../failure/failure.ts'
import { contentTree, gitContext, reviewChangedPaths } from '../git/git-environment.ts'
import {
  formatIdleKillError,
  idleKillMayProceed,
  idlePollMs,
  sampleProcesses,
  shouldIdleKill,
  terminateProcessGroup,
} from '../idle-kill.ts'
import { type Job, jobIdleKillMs } from '../jobs/jobs.ts'
import { deriveLiveOutcome } from '../live-outcome.ts'
import { receiptWorkerMessages, unreadWorkerMessages } from '../mailbox/mailbox.ts'
import { deferredWorkerMessageNotice } from '../mailbox/mailbox-notice.ts'
import { decideOutcome, type OutcomeStatus } from '../outcome.ts'
import { processStartTime } from '../project/project-lock.ts'
import type { CodexMcpServer } from '../sandbox/codex-mcp-scope.ts'
import type { SandboxSelection } from '../sandbox/sandbox.ts'
import {
  EMPTY_VENDOR_USAGE,
  type TransportHandle,
  type TransportName,
  type TransportResult,
  type TransportStartOpts,
  transportFor,
  type VendorUsage,
  valueMatchesStrictSchema,
} from '../transport/transport.ts'
import type { Worktree } from '../worktree/worktree-types.ts'
import {
  checkpointRun,
  DEFAULT_CHECKPOINT_MINUTES,
  latestCheckpoint,
  recordFailedIdlePreservation,
} from './checkpoint.ts'
import { questionOpenSql } from './question-open.ts'
import { prepareLaterRunBoardPrompt } from './run-board-prompt.ts'
import { startRunAfterHostCapacity, waitForRunHostCapacity } from './run-host-capacity.ts'
import { STALE_AFTER_MS } from './run-liveness.ts'
import { childEnv, errorTail, live, liveCheckpoints } from './run-process.ts'
import { decideReplySource, type ReplyContract } from './run-reply-source.ts'
import { checkpointRoot, resumeFacts } from './run-resume-kind.ts'
import {
  appendGateExclusionToTimeoutError,
  currentExcludedGateMs,
  decideRunWallDeadline,
  excludedGateIntervalMs,
  gateExclusionNoteSuffix,
  type RunWallDeadlineFacts,
} from './run-wall-deadline.ts'
import {
  closeWorkerExecutionBrokers,
  startWorkerExecutionBrokers,
  type WorkerExecutionBrokers,
} from './run-worker-brokers.ts'

function readReplyFile(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

function replyContract(schemaPath: string | undefined, textContract: boolean): ReplyContract {
  if (schemaPath) return 'custom'
  return textContract ? 'text' : 'none'
}

function outputCeilingReached(
  reply: { text: string; stopReason?: string | null } | null,
  ceilingReason: string | null,
): boolean {
  return Boolean(
    reply && !reply.text.trim() && ceilingReason !== null && reply.stopReason === ceilingReason,
  )
}

function liveChildEnv(
  agent: Agent,
  runRecordId: string,
  runToken: string,
  extra: Record<string, string>,
  includeStore: boolean,
  runNumber: number,
): Record<string, string> {
  return childEnv(agent, runRecordId, runToken, extra, includeStore, runNumber)
}

function recordConfiguredAsk(input: {
  runId: string
  sandbox: SandboxSelection['sandbox']
  transport: ReturnType<typeof transportFor>
  startOpts: TransportStartOpts
}): void {
  try {
    const command = input.transport.configuredAsk(input.startOpts)
    if (command) {
      recordAskExpected(input.runId, input.sandbox === 'srt' ? 'srt' : 'host', command)
    }
  } catch {
    // Configuration evidence is best effort and must never prevent launch.
  }
}

function replyFileMatches(
  contract: ReplyContract,
  text: string | null,
  dialect: ReplyDialect,
  schema: Parameters<typeof validatesSchema>[1],
): boolean {
  if (text === null) return false
  if (contract !== 'custom') return dialect.parse(text).reply !== null
  try {
    return validatesSchema(JSON.parse(text), schema)
  } catch {
    return false
  }
}

function fallbackMatches(contract: ReplyContract, text: string, schema: unknown): boolean {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return false
  }
  if (contract === 'text') return valueMatchesStrictSchema(TEXT_REPLY_SCHEMA, value)
  if (contract === 'custom') return valueMatchesStrictSchema(schema, value)
  return false
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
  noWaitCapacity?: boolean
}

async function startAfterHostCapacity(input: {
  repoJob: boolean
  claim: { id: string }
  opts: Pick<LiveOptions, 'noWaitCapacity' | 'resume'>
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
            skip: Boolean(input.opts.noWaitCapacity),
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
  })
  const hostWait = result.wait
  if (hostWait?.boundReached) {
    const message = `host capacity wait bound reached after ${hostWait.waitedMs}ms; starting run`
    console.error(`orch: ${message}`)
    recordRunWarning(runId, message)
  }
  if (!result.handle) throw new Error('run stopped while waiting for host capacity')
  return result.handle
}

const warnForRun = (runId: string) => (message: string) => recordRunWarning(runId, message)

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
  mcpTrustGranted: boolean
  writableRoots: string[]
  gitConfigEnvironment: Record<string, string> | undefined
  sandboxRunDir: string
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
}

export type LiveResult = {
  proc: { pid?: number | null; kill(sig?: number | string): void } | null
  timer: ReturnType<typeof setTimeout> | null
  checkpointTimer: ReturnType<typeof setInterval> | null
  idleTimer: ReturnType<typeof setInterval> | null
  timedOut: boolean
  idleKilled: boolean
  idleKillError: string | null
  idleUnkillable: boolean
  idleTreePids: number[]
  idleTreePgid: number | null
  exitCode: number
  output: string
  vendorTokens: number | null
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
  confinementFailures: FreezeFailure[]
  confinementEvent: ConfinementEvent | null
  frozenBefore: import('../confinement/confinement.ts').FrozenCheckout[]
  askLoopback: AskLoopback | null
  mcpSetupHeader: string | null
  workerEvents: StreamEvent[]
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

function idleRunRow(runId: string): {
  status: string
  last_event_at: string | null
  started_at: string
} | null {
  return db()
    .query('SELECT status, last_event_at, started_at FROM run WHERE record_id=?')
    .get(runId) as {
    status: string
    last_event_at: string | null
    started_at: string
  } | null
}

function runHasOpenQuestion(runId: string): boolean {
  return Boolean(
    db()
      .query(
        `SELECT 1 n FROM question WHERE run_record_id=? AND ${questionOpenSql('question')} LIMIT 1`,
      )
      .get(runId),
  )
}

function recordedRunStatus(runId: string): string | null {
  return (
    (
      db().query('SELECT status FROM run WHERE record_id=?').get(runId) as {
        status: string
      } | null
    )?.status ?? null
  )
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
    sandboxRunDir,
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
  let idleTimer: ReturnType<typeof setInterval> | null = null
  let timedOut = false
  let idleKilled = false
  let idleKillError: string | null = null
  let idleUnkillable = false
  let idleTreePids: number[] = []
  let idleTreePgid: number | null = null
  let exitCode = -1
  let output = ''
  let vendorTokens: number | null = null
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
  const confinementFailures: FreezeFailure[] = []
  const confinementEvent: ConfinementEvent | null = null
  const frozenBefore: import('../confinement/confinement.ts').FrozenCheckout[] = []
  let askLoopback: AskLoopback | null = null
  let executionBrokers: WorkerExecutionBrokers | null = null
  let noteBroker: WorkerNoteBroker | null = null
  let workerEvents: StreamEvent[] = []
  let wallArmedAtMs: number | null = null
  let accruedGateMs = 0
  let gateStartedAtMs: number | null = null
  let excludedGateMsAtTimeout = 0
  let rearmWallDeadline = () => {}
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
    if (sandboxSelection.sandbox === 'srt') {
      askLoopback = await startAskLoopback(claim.id, runToken)
    }
    executionBrokers = startWorkerExecutionBrokers({
      repoJob,
      writesRepo: writesJob,
      worktree,
      runId: claim.id,
      scratchDir,
      environment: { ...(gitConfigEnvironment ?? {}), ...recipeEnvironment },
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
    const checkpointNotices = boardDelivery.notices
    prompt = boardDelivery.prompt
    const startOpts: TransportStartOpts = {
      agent: a,
      cwd,
      prompt,
      outPath,
      // ACP uses session/new; treating Grok's fresh CLI id as resumable makes ACP
      // issue session/load against a session that cannot exist yet.
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
      sandbox: codexSandbox.sandbox,
      sandboxWorkspaceWriteNetworkAccess: codexSandbox.workspaceWriteNetworkAccess,
      mcp: usingMcp,
      mcpServer: mcpServerName ?? undefined,
      projectServers: codexMcpScope?.servers,
      trustCwd: mcpTrustGranted ? cwd : undefined,
      writableRoots,
      gitConfigEnvironment,
      recipeEnvironment,
      srt: sandboxSelection.profile
        ? { profile: sandboxSelection.profile, runtimeDir: sandboxRunDir }
        : undefined,
      resume: resumeFacts(opts.resume?.kind ?? null, claim.id, opts.resume?.parent ?? null)
        .carriesVendorSession,
      env: liveChildEnv(
        a,
        claim.recordId,
        runToken,
        {
          ...launchEnvironment,
          ORCH_SCRATCH: scratchDir,
          ...(askLoopback ? { ORCH_ASK_URL: askLoopback.url } : {}),
        },
        repoJob,
        claim.number,
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
    // The VENDOR CLI pid. pid stays the worker's for the whole run: after the
    // agent exits the worker is still parsing output and writing questions, and
    // a reaper that tested this pid would mark the run stale under a process
    // about to write its real outcome.
    //
    // Recorded HERE, before the wait, not after it. Written afterwards it is
    // always the pid of a process that has already exited.
    // Idle is silence of the VENDOR, not of orch's own setup. last_event_at
    // and the reclaimed-wall clock both start here so a slow worktree cut
    // cannot burn either budget.
    const vendorStartedAt = Date.now()
    const vendorPid = handle.pid ?? null
    const vendorSample =
      vendorPid && vendorPid > 1
        ? sampleProcesses().find((row) => row.pid === vendorPid)
        : undefined
    const vendorPgid = vendorSample && vendorSample.pgid > 1 ? vendorSample.pgid : null
    const vendorStartTime = vendorPid && vendorPid > 1 ? processStartTime(vendorPid) : null
    db()
      .query(
        `UPDATE run SET agent_pid=?, agent_pgid=?, agent_start_time=?, host_wait_since=NULL,
              last_event_at=COALESCE(last_event_at, ?) WHERE record_id=?`,
      )
      .run(vendorPid, vendorPgid, vendorStartTime, nowIso(), claim.id)
    const createCheckpoint = (final = false) => {
      if (!writesJob || !worktree || !launchKey) return null
      const result = checkpointRun({
        database: db(),
        runId: claim.id,
        worktree: worktree.path,
        branch: worktree.branch,
        taskKey: launchKey,
        scratchDir,
        guardEnvironment: gitConfigEnvironment ?? {},
        final,
      })
      if (result.error) console.error(`orch: run ${claim.id} checkpoint failed: ${result.error}`)
      return result
    }
    if (writesJob) {
      checkpointTimer = setInterval(
        () => {
          createCheckpoint(false)
        },
        (requestedJob.checkpointMinutes ?? DEFAULT_CHECKPOINT_MINUTES) * 60_000,
      )
      if (worktree && launchKey) {
        liveCheckpoints.set(handle, {
          runId: claim.id,
          rootId: checkpointRoot(opts.resume, claim.id),
          worktree: worktree.path,
          branch: worktree.branch,
          taskKey: launchKey,
          scratchDir,
          guardEnvironment: gitConfigEnvironment ?? {},
        })
      }
    }
    // Two timeouts, composed, not one: the wall stays, and idle kill is the
    // second, shorter no-activity bound. Do not replace the wall.
    wallArmedAtMs = Date.now()
    const expireWall = () => {
      rearmWallDeadline = () => {}
      if (idleKilled) return
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
          ceilingMs: STALE_AFTER_MS - 1,
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
    const maybeIdleKill = async () => {
      const row = idleRunRow(claim.id)
      if (!row) return
      const openQuestion = runHasOpenQuestion(claim.id)
      const idleThresholdMs = jobIdleKillMs(opts.job, process.env, boundMs)
      const decision = shouldIdleKill({
        lastEventAt: row.last_event_at,
        startedAt: row.started_at,
        pid: handle.pid,
        asking: row.status === 'asking',
        openQuestion,
        alreadyTimedOut: timedOut,
        alreadyIdleKilled: idleKilled,
        thresholdMs: idleThresholdMs,
      })
      if (!decision.kill) return
      idleKilled = true
      const elapsed = Date.now() - vendorStartedAt
      idleKillError = formatIdleKillError({
        idleMs: decision.idleMs ?? 0,
        reclaimedMs: Math.max(0, boundMs - elapsed),
        boundMs,
      })
      const checkpoint = createCheckpoint(true)
      const afterCheckpoint = recordedRunStatus(claim.id)
      const askedDuringCheckpoint = afterCheckpoint === 'asking' || runHasOpenQuestion(claim.id)
      if (askedDuringCheckpoint) {
        idleKilled = false
        idleKillError = null
        appendRunEvent(claim.id, {
          ts: nowIso(),
          type: 'text',
          text: 'idle kill aborted: worker asked during checkpoint',
        })
        return
      }
      const prior = latestCheckpoint(db(), checkpointRoot(opts.resume, claim.id))
      if (!idleKillMayProceed(checkpoint, Boolean(prior))) {
        idleKilled = false
        idleKillError = null
        const why = checkpoint?.error ?? 'checkpoint failed'
        console.error(
          `orch: run ${claim.id} idle kill aborted: ${why}; no prior checkpoint, leaving the worker for the wall`,
        )
        recordFailedIdlePreservation({
          runId: claim.id,
          scratchDir,
          worktree: worktree?.path ?? null,
          error: why,
        })
        return
      }
      if (checkpoint?.created || prior) {
        db().query('UPDATE run SET work_preserved=1 WHERE record_id=?').run(claim.id)
      }
      void t.cancel(handle)
      const terminated = await terminateProcessGroup(handle.pid ?? 0, {
        direct: handle,
      })
      idleTreePids = terminated.pids
      idleTreePgid = terminated.pgid
      idleUnkillable = terminated.unkillable
      if (terminated.unkillable) {
        idleKillError = formatIdleKillError({
          idleMs: decision.idleMs ?? 0,
          reclaimedMs: Math.max(0, boundMs - elapsed),
          boundMs,
          unkillable: true,
          unkillableReason: terminated.reason,
        })
        forceCollect?.({
          stdout: '',
          stderr: idleKillError,
          raw: '',
          parsed: null,
          output: '',
          tokens: null,
          costUsd: null,
          vendorUsage: EMPTY_VENDOR_USAGE,
          sessionId: null,
          stopReason: 'timeout',
          error: idleKillError,
          exitCode: -1,
          pid: handle.pid ?? 0,
          events: [],
          asking: false,
          failureKind: 'idle',
          status: 'failed',
          questions: [],
        })
      }
    }
    let idleCheckInFlight = false
    idleTimer = setInterval(
      () => {
        if (idleCheckInFlight || timedOut || idleKilled) return
        idleCheckInFlight = true
        void maybeIdleKill()
          .catch((error) => {
            console.error(`orch: run ${claim.id} idle check failed: ${error}`)
          })
          .finally(() => {
            idleCheckInFlight = false
          })
      },
      idlePollMs(jobIdleKillMs(opts.job, process.env, boundMs)),
    )
    const teeing = teeTransportEvents(handle.events(), claim.id)
    await t.prompt(handle, prompt)
    receiptWorkerMessages(
      claim.id,
      checkpointMessages.map((message) => message.id),
    )
    await markRunBoardNoticesDelivered(claim.id, [
      ...initialBoardNoticeIds,
      ...checkpointNotices.map((notice) => notice.id),
    ])
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
    const replyError = reply?.error ?? collected.error
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
    const ruling = decideReplySource({
      replyFile:
        replyFileText !== null
          ? {
              present: true,
              text: replyFileText,
              matches: replyFileMatches(
                replyContractKind,
                replyFileText,
                resolvedDialect,
                validationSchema,
              ),
            }
          : { present: false },
      contract: replyContractKind,
      fallback: {
        text: output,
        matches: fallbackMatches(replyContractKind, output, validationSchema),
      },
    })
    output = ruling.output
    replyFileError = ruling.replyFileError
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
        `undelivered worker messages: ${undelivered.map((message) => message.id).join(', ')}`,
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
      idleKilled,
      idleKillError,
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

    if (idleKilled && derived.inputs.completedReply) {
      console.error(
        `orch: run ${claim.id} had already returned a complete reply when idle-killed. ` +
          `Recorded ${acceptedQuestions.length ? 'asking' : 'ok'}.`,
      )
    } else if (
      timedOut &&
      derived.inputs.completedReplyAtTimeout &&
      !idleKilled &&
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
  await closeWorkerExecutionBrokers(executionBrokers)
  await closeWorkerNoteBroker(noteBroker)

  return {
    proc,
    timer,
    checkpointTimer,
    idleTimer,
    timedOut,
    idleKilled,
    idleKillError,
    idleUnkillable,
    idleTreePids,
    idleTreePgid,
    exitCode,
    output,
    vendorTokens,
    costUsd,
    vendorUsage,
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
    confinementFailures,
    confinementEvent,
    frozenBefore,
    askLoopback,
    mcpSetupHeader,
    workerEvents,
  }
}
