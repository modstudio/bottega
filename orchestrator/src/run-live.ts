// concern: run-live
/**
 * Knows spawning, watching, and classifying one live vendor process. Must not
 * know run claiming, terminalisation, failover, dispatch surfaces, or the CLI.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Agent } from './agents.ts'
import { type AskLoopback, startAskLoopback } from './ask/ask.ts'
import {
  checkpointRun,
  DEFAULT_CHECKPOINT_MINUTES,
  latestCheckpoint,
  recordFailedIdlePreservation,
} from './checkpoint.ts'
import type { CodexMcpServer } from './codex-mcp-scope.ts'
import type { ConfinementEvent, FreezeFailure } from './confinement.ts'
import {
  isAsking,
  REPLY_FILE_NAME,
  type ReplyDialect,
  realQuestions,
  TEXT_REPLY_SCHEMA,
  validatesSchema,
  type WorkerReply,
} from './contract.ts'
import { db, nowIso } from './db.ts'
import { appendRunEvent, teeTransportEvents } from './events.ts'
import { classify, FAILS_OVER, hasVendorTerminationMarker, isNonAnswer } from './failure.ts'
import {
  contentTree,
  gitContext,
  targetGitEnvironment,
  type WorktreeObjectEnvironment,
} from './git-environment.ts'
import {
  formatIdleKillError,
  idleKillMayProceed,
  idlePollMs,
  sampleProcesses,
  shouldIdleKill,
  terminateProcessGroup,
} from './idle-kill.ts'
import { type Job, jobIdleKillMs } from './jobs.ts'
import { receiptWorkerMessages, unreadWorkerMessages } from './mailbox/mailbox.ts'
import { decideOutcome } from './outcome.ts'
import { processStartTime } from './project-lock.ts'
import { childEnv, errorTail, live, liveCheckpoints } from './run-process.ts'
import type { SandboxSelection } from './sandbox.ts'
import {
  failureKindFromStop,
  schemaMismatchError,
  stopErrorMessage,
  type TransportName,
  type TransportResult,
  type TransportStartOpts,
  transportFor,
  valueMatchesStrictSchema,
} from './transport/transport.ts'
import type { Worktree } from './worktree-types.ts'

function reviewChangedPaths(cwd: string, base: string, inputTree: string): string[] {
  const args = ['diff', '--name-only', `${base}..${inputTree}`]
  const p = Bun.spawnSync(['git', '-C', cwd, ...args], {
    env: targetGitEnvironment(cwd),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (p.exitCode !== 0) {
    throw new Error(
      `could not measure explicit review paths with git ${args.join(' ')}: ` +
        (p.stderr.toString().trim() || `exit ${p.exitCode}`),
    )
  }
  return p.stdout.toString().trim().split('\n').filter(Boolean)
}

function presentReplyFileMatches(opts: {
  text: string
  schema: unknown
  customSchema: boolean
  dialect: ReplyDialect
}): boolean {
  const schema = opts.schema as Parameters<typeof validatesSchema>[1]
  if (opts.customSchema) {
    let value: unknown
    try {
      value = JSON.parse(opts.text)
    } catch {
      return false
    }
    return validatesSchema(value, schema)
  }
  return opts.dialect.parse(opts.text).reply !== null
}

type LiveOptions = {
  resume?: { parent: number; fresh?: boolean; session?: string }
  model?: string
  schemaPath?: string
  job: string
}

export type LiveInput = {
  repoJob: boolean
  name: string
  worktree: Worktree | null
  claim: { id: number }
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
  gitObjectEnvironment: WorktreeObjectEnvironment | undefined
  gitConfigEnvironment: Record<string, string> | undefined
  sandboxRunDir: string
  grokMcpEnvironment: Record<string, string>
  recipeEnvironment: Record<string, string>
  scratchDir: string
  writesJob: boolean
  launchKey: string | null
  requestedJob: Job
  boundMs: number
  started: number
  textReplyContract: boolean
  resolvedDialect: ReplyDialect
  mcpSetupHeader: string | null
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
  resolvedSession: string | null
  effectiveModel: string | null
  replyFileError: string | null
  replyFilePresent: boolean
  contract: WorkerReply | null
  contractObjects: number
  acceptedQuestions: ReturnType<typeof realQuestions>
  status: string
  error: string | null
  failureKind: ReturnType<typeof classify> | null
  artifactsPersisted: boolean
  preConfinement: string | null
  vendorTerminatedStream: string | null
  confinementFailures: FreezeFailure[]
  confinementEvent: ConfinementEvent | null
  frozenBefore: import('./confinement.ts').FrozenCheckout[]
  askLoopback: AskLoopback | null
  mcpSetupHeader: string | null
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
    gitObjectEnvironment,
    gitConfigEnvironment,
    sandboxRunDir,
    grokMcpEnvironment,
    recipeEnvironment,
    scratchDir,
    writesJob,
    launchKey,
    requestedJob,
    boundMs,
    started,
    textReplyContract,
    resolvedDialect,
    mcpSetupHeader,
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
  let resolvedSession: string | null = vendorSession
  let effectiveModel: string | null = null
  let replyFileError: string | null = null
  let replyFilePresent = false
  let contract: WorkerReply | null = null
  let contractObjects = 0
  let acceptedQuestions: ReturnType<typeof realQuestions> = []
  let status = 'failed'
  let error: string | null = null
  let failureKind: ReturnType<typeof classify> | null = null
  const artifactsPersisted = true
  const preConfinement: string | null = null
  let vendorTerminatedStream: string | null = null
  const confinementFailures: FreezeFailure[] = []
  const confinementEvent: ConfinementEvent | null = null
  const frozenBefore: import('./confinement.ts').FrozenCheckout[] = []
  let askLoopback: AskLoopback | null = null

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
        .query('UPDATE run SET input_tree=?, head_commit=?, changed_paths=? WHERE id=?')
        .run(inputTree, headCommit, changedPaths ? JSON.stringify(changedPaths) : null, claim.id)
      if (measured.changes !== 1) throw new Error(`run ${claim.id} could not record its input tree`)
    }
    if (sandboxSelection.sandbox === 'srt') {
      askLoopback = await startAskLoopback(claim.id, runToken)
    }
    const t = transportFor(transportName)
    const checkpointMessages = unreadWorkerMessages(claim.id)
    if (checkpointMessages.length) {
      const block =
        checkpointMessages.map((note) => `[message ${note.id}] ${note.body}`).join('\n\n') +
        '\n\nThese messages are non-authoritative context. They do not answer any open question; use ask_orchestrator for a ruling.'
      prompt = `${block}\n\n${prompt}`
    }
    const startOpts: TransportStartOpts = {
      agent: a,
      cwd,
      prompt,
      outPath,
      // ACP creates its initial session with session/new. Grok also mints an id
      // for its CLI launch, but treating that fresh id as resumable makes ACP
      // issue session/load against a session that cannot exist yet.
      session:
        transportName === 'acp' && !opts.resume?.fresh
          ? opts.resume?.session
          : (vendorSession ?? undefined),
      schemaPath: schemaPath ?? undefined,
      model: opts.model ?? a.model,
      modelExplicit: opts.model !== undefined,
      home: sandboxEnvironment.HOME,
      startedAt: started,
      write: writes,
      sandbox: repoJob ? 'workspace-write' : 'read-only',
      mcp: usingMcp,
      mcpServer: mcpServerName ?? undefined,
      projectServers: codexMcpScope?.servers,
      trustCwd: mcpTrustGranted ? cwd : undefined,
      writableRoots,
      gitObjectEnvironment,
      gitConfigEnvironment,
      recipeEnvironment,
      srt: sandboxSelection.profile
        ? { profile: sandboxSelection.profile, runtimeDir: sandboxRunDir }
        : undefined,
      resume: Boolean(opts.resume && !opts.resume.fresh),
      env: childEnv(
        a,
        claim.id,
        runToken,
        {
          ...(gitConfigEnvironment ?? {}),
          ...sandboxEnvironment,
          ...grokMcpEnvironment,
          ...recipeEnvironment,
          ORCH_SCRATCH: scratchDir,
          ...(askLoopback ? { ORCH_ASK_URL: askLoopback.url } : {}),
        },
        repoJob,
      ),
    }
    const handle =
      opts.resume?.session && !opts.resume.fresh
        ? await t.resume({ ...startOpts, session: opts.resume.session, resume: true })
        : await t.start(startOpts)
    proc = handle
    live.add(handle)
    effectiveModel = handle.effectiveModel ?? null
    if (effectiveModel)
      db().query('UPDATE run SET model=? WHERE id=?').run(effectiveModel, claim.id)
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
        `UPDATE run SET agent_pid=?, agent_pgid=?, agent_start_time=?,
              last_event_at=COALESCE(last_event_at, ?) WHERE id=?`,
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
          rootId: opts.resume?.parent ?? claim.id,
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
    timer = setTimeout(() => {
      if (idleKilled) return
      timedOut = true
      void t.cancel(handle)
      // Descendant-aware SIGTERM, bounded grace, then SIGKILL. A CLI that
      // ignores SIGTERM would otherwise keep the caller waiting for ever.
      void terminateProcessGroup(handle.pid ?? 0, { direct: handle })
    }, boundMs)

    let forceCollect: ((result: TransportResult) => void) | null = null
    const forcedCollect = new Promise<TransportResult>((resolve) => {
      forceCollect = resolve
    })
    const maybeIdleKill = async () => {
      const row = db()
        .query('SELECT status, last_event_at, started_at FROM run WHERE id=?')
        .get(claim.id) as {
        status: string
        last_event_at: string | null
        started_at: string
      } | null
      if (!row) return
      const openQuestion = db()
        .query('SELECT 1 n FROM question WHERE run_id=? AND answered_at IS NULL LIMIT 1')
        .get(claim.id) as { n: number } | null
      const idleThresholdMs = jobIdleKillMs(opts.job, process.env, boundMs)
      const decision = shouldIdleKill({
        lastEventAt: row.last_event_at,
        startedAt: row.started_at,
        pid: handle.pid,
        asking: row.status === 'asking',
        openQuestion: Boolean(openQuestion),
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
      const afterCheckpoint = db().query('SELECT status FROM run WHERE id=?').get(claim.id) as {
        status: string
      } | null
      const askedDuringCheckpoint =
        afterCheckpoint?.status === 'asking' ||
        Boolean(
          db()
            .query('SELECT 1 n FROM question WHERE run_id=? AND answered_at IS NULL LIMIT 1')
            .get(claim.id),
        )
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
      const prior = latestCheckpoint(db(), opts.resume?.parent ?? claim.id)
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
        db().query('UPDATE run SET work_preserved=1 WHERE id=?').run(claim.id)
      }
      void t.cancel(handle)
      const terminated = await terminateProcessGroup(handle.pid ?? 0, { direct: handle })
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
    const collected = await Promise.race([handle.collect(), forcedCollect])
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
    const outputCeilingReached =
      !!reply &&
      !reply.text.trim() &&
      a.outputCeilingStopReason !== null &&
      reply.stopReason === a.outputCeilingStopReason
    vendorTokens = collected.tokens
    costUsd = collected.costUsd
    effectiveModel = collected.effectiveModel ?? effectiveModel
    resolvedSession = collected.sessionId ?? vendorSession
    output = collected.output
    const replyFile = join(scratchDir, REPLY_FILE_NAME)
    if (existsSync(replyFile)) {
      replyFilePresent = true
      const fileOutput = readFileSync(replyFile, 'utf8')
      output = fileOutput
      const validationSchema = JSON.parse(readFileSync(originalSchemaPath!, 'utf8'))
      if (
        !presentReplyFileMatches({
          text: fileOutput,
          schema: validationSchema,
          customSchema: Boolean(opts.schemaPath),
          dialect: resolvedDialect,
        })
      ) {
        replyFileError = `${REPLY_FILE_NAME} did not match the worker contract:\n${fileOutput}`
      } else if (textReplyContract) {
        output = (JSON.parse(fileOutput) as { answer: string }).answer
      }
      writeFileSync(outPath, output)
    } else if (textReplyContract) {
      // The public result stays plain text. A conforming fallback final message
      // uses the file envelope, while legacy prose remains readable.
      try {
        const value = JSON.parse(output)
        if (valueMatchesStrictSchema(TEXT_REPLY_SCHEMA, value)) output = value.answer
      } catch {
        /* Missing-file fallback may be the legacy plain-text result. */
      }
      writeFileSync(outPath, output)
    }
    if (!replyFilePresent && opts.schemaPath) {
      let value: unknown
      try {
        value = JSON.parse(output)
      } catch {
        value = null
      }
      const validationSchema = JSON.parse(readFileSync(originalSchemaPath!, 'utf8'))
      if (!valueMatchesStrictSchema(validationSchema, value)) {
        replyFileError = schemaMismatchError(output)
      }
    }
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
     * later — by a harness command timeout, by SIGTERM travelling down a
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
      const header = `undelivered worker messages: ${undelivered.map((message) => message.id).join(', ')}`
      mcpSetupHeader = mcpSetupHeader ? `${mcpSetupHeader}\n${header}` : header
    }
    if (writesJob && output) {
      const parsed = resolvedDialect.parse(output)
      contract = parsed.reply as WorkerReply | null
      contractObjects = parsed.contractObjects
    }
    const questionsControlStatus = isAsking(contract) || contract?.status === 'done'
    acceptedQuestions = questionsControlStatus ? realQuestions(contract) : transportQuestions

    const completedReplyAtTimeout =
      contract?.status === 'done' || (!writesJob && !replyError && !!output && !isNonAnswer(output))
    const acpVendorStop =
      transportName === 'acp' &&
      collected.status === 'failed' &&
      Boolean(collected.stopReason && collected.stopReason !== 'end_turn')
    // A completed reply outranks an idle kill, exactly as the wall recovery
    // does: a parsed contract or a reply.json already on disk is finished work,
    // not an idle failure. Idle still outranks the transport stop reason so an
    // ACP/CLI cancel does not rewrite the kill as a timeout.
    const completedReply =
      completedReplyAtTimeout ||
      (replyFilePresent && !replyFileError && (contract?.status === 'done' || !writesJob))
    const acpFailureKind =
      collected.failureKind ?? failureKindFromStop(collected.stopReason, collected.error)
    const replyErrorFailureKind = classify(
      replyError ?? '',
      exitCode,
      timedOut,
      sandboxSelection.sandbox,
    )
    const nonAnswer = exitCode === 0 && isNonAnswer(output)
    const nonAnswerFailureKind = classify(output, exitCode, timedOut, sandboxSelection.sandbox)
    const completedContractTerminal = stderr.trim() || stdout.trim()
    const completedContractFailureKind = classify(
      completedContractTerminal,
      exitCode,
      timedOut,
      sandboxSelection.sandbox,
    )
    const missingContractTerminal = stderr.trim() || output || stdout.trim()
    const classifiedMissingContract = classify(
      missingContractTerminal,
      exitCode,
      timedOut,
      sandboxSelection.sandbox,
    )
    const missingContractFailureKind = FAILS_OVER.includes(classifiedMissingContract)
      ? classifiedMissingContract
      : 'other'
    const defaultError = errorTail(
      stderr.trim() || stdout.trim() || `exit ${exitCode}, empty output`,
    )
    const defaultFailureKind = classify(defaultError, exitCode, timedOut, sandboxSelection.sandbox)

    if (idleKilled && completedReply) {
      error = null
      console.error(
        `orch: run ${claim.id} had already returned a complete reply when idle-killed. ` +
          `Recorded ${acceptedQuestions.length ? 'asking' : 'ok'}.`,
      )
    } else if (idleKilled && (collected.asking || acceptedQuestions.length)) {
      error = null
    } else if (idleKilled) {
      error = errorTail(idleKillError ?? 'idle-killed with no CPU')
    } else if (acpVendorStop) {
      error = errorTail(collected.error ?? stopErrorMessage(collected.stopReason!))
    } else if (replyFileError) {
      error = errorTail(replyFileError)
    } else if (collected.asking || acceptedQuestions.length) {
      error = null
    } else if (outputCeilingReached) {
      error = `response truncated at output ceiling (${reply!.stopReason})`
    } else if (timedOut && completedReplyAtTimeout) {
      /**
       * IT FINISHED, AND THEN WE KILLED IT.
       *
       * A writing agent proves completion with its contract. A read-only
       * agent's answer IS its output, and completeness belongs to the later
       * delivery/quality judgement; requiring a writer-only contract here made
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
      error = null
      console.error(
        `orch: run ${claim.id} had already returned a complete reply when the ` +
          `${Math.round(boundMs / 60_000)}m bound killed it. Recorded ` +
          `${acceptedQuestions.length ? 'asking' : 'ok'}; the bound may be short.`,
      )
    } else if (timedOut) {
      error = `no reply within ${Math.round(boundMs / 60_000)}m; ${name} was killed`
    } else if (replyError) {
      error = errorTail(replyError)
    } else if (nonAnswer) {
      // Exit 0 and non-empty, but what came back is the vendor saying it
      // failed. Recorded as the failure it is rather than stored as an answer:
      // a run nobody can use should cost the agent the same as one that
      // crashed, not sit in the table looking like a success until a person
      // reads 57 bytes and works it out.
      error = errorTail(output)
    } else if (contract?.status === 'refused') {
      // The worker read the spec and says it cannot be built as written. That
      // is a real answer and often a correct one, so it is `ok` rather than a
      // failure: the agent did its job. Whether the refusal was RIGHT is a
      // quality judgement, which is the architect's to make and the score's to
      // record — not something to decide here from the word alone.
      error = null
    } else if (exitCode !== 0 && contract?.status === 'done') {
      // The agent finished and wrote a complete reply, and THEN the process
      // died — a killed process group, most often. The work exists; saying so
      // is more honest than either 'ok' (it was interrupted) or a contract
      // complaint about a contract that was satisfied.
      error = errorTail(
        (FAILS_OVER.includes(completedContractFailureKind)
          ? `${completedContractTerminal}\n`
          : '') +
          `the worker completed and wrote its reply, then the process ended ` +
          `(exit ${exitCode}). Its work is in the worktree; resume or read the diff.`,
      )
    } else if (writesJob && !contract) {
      // A writing run whose reply cannot be parsed has not reported what it
      // did, and its diff may be anything at all. Recording it `ok` would put
      // an unverifiable change set into the record as a completed one.
      if (FAILS_OVER.includes(classifiedMissingContract)) {
        error = errorTail(missingContractTerminal)
      } else {
        error = errorTail(`reply did not match the worker contract:\n${output}`)
      }
    } else {
      error = exitCode === 0 && output ? null : defaultError
    }

    ;({ status, failureKind } = decideOutcome({
      idleKilled,
      completedReply,
      collectedAsking: collected.asking,
      acceptedQuestions: acceptedQuestions.length > 0,
      acpVendorStop,
      acpFailureKind,
      replyFileError: Boolean(replyFileError),
      replyFilePresent,
      outputCeilingReached,
      timedOut,
      completedReplyAtTimeout,
      replyError: Boolean(replyError),
      replyErrorFailureKind,
      nonAnswer,
      nonAnswerFailureKind,
      contractStatus: contract?.status ?? null,
      exitCode,
      completedContractFailureKind,
      missingRequiredContract: writesJob && !contract,
      missingContractFailureKind,
      outputPresent: Boolean(output),
      defaultFailureKind,
    }))
  } catch (e) {
    // Spawn refused, a pipe broke, the output file could not be written. The row
    // exists and must not be left claiming to run.
    status = 'failed'
    error = errorTail(proc ? String((e as Error)?.stack ?? e) : String((e as Error)?.message ?? e))
    failureKind = proc ? 'other' : 'harness'
  }

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
    artifactsPersisted,
    preConfinement,
    vendorTerminatedStream,
    confinementFailures,
    confinementEvent,
    frozenBefore,
    askLoopback,
    mcpSetupHeader,
  }
}
