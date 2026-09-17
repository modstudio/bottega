// concern: run-terminal
/**
 * Knows terminal process cleanup, run outcome finalization, evidence recording,
 * terminal row writes, and artifact persistence. Must not know run claiming,
 * live worker execution, run control, dispatch surfaces, or the CLI.
 */
import type { Database } from 'bun:sqlite'
import { writeFileSync } from 'node:fs'
import type { AskLoopback } from './ask/ask.ts'
import { checkpointRun, latestCheckpoint } from './checkpoint.ts'
import {
  type CheckoutToWatch,
  type ConfinementEvent,
  classifyDivergence,
  type FreezeFailure,
  type FrozenCheckout,
  freezeCheckouts,
  overlappingError,
} from './confinement.ts'
import {
  parseReaderOutput,
  type ReplyDialect,
  type ReviewReply,
  type realQuestions,
  type WorkerReply,
} from './contract/contract.ts'
import { db, nowIso, tryWriteContention, writeTransaction } from './db.ts'
import { assessEvidence, recordEvidence } from './evidence.ts'
import { type classify, detectBlockers } from './failure.ts'
import { terminateProcessGroup } from './idle-kill.ts'
import { isReaderJob, type Job } from './jobs.ts'
import { machineId } from './machine-identity.ts'
import type { McpConnection, McpMode } from './mcp-preflight.ts'
import { finalizeWorkerReply } from './outcome.ts'
import { projectByName, projects } from './projects.ts'
import { teardownTerminalRunResources } from './resource-ownership.ts'
import { cleanReviewEvidence } from './review.ts'
import {
  persistRunArtifacts,
  persistTerminalSnapshot,
  runArtifactsDir,
  runTerminalReplyPath,
  type TerminalSnapshot,
} from './run-artifacts.ts'
import { resolveRootFromLastTurn } from './run-liveness.ts'
import { enqueueRunRecord } from './run-outbox.ts'
import { errorTail, live, liveCheckpoints } from './run-process.ts'
import { resetSandbox } from './sandbox.ts'
import { type Changes, changesIn } from './worktree-remove.ts'
import type { Worktree } from './worktree-types.ts'

type TerminalOptions = {
  job: string
  resume?: { parent: number }
}

export type TerminalInput = {
  timer: ReturnType<typeof setTimeout> | null
  checkpointTimer: ReturnType<typeof setInterval> | null
  idleTimer: ReturnType<typeof setInterval> | null
  proc: { pid?: number | null; kill(sig?: number | string): void } | null
  askLoopback: AskLoopback | null
  claim: { id: number }
  writesJob: boolean
  worktree: Worktree | null
  launchKey: string | null
  failureKind: ReturnType<typeof classify> | null
  scratchDir: string
  gitConfigEnvironment: Record<string, string> | undefined
  opts: TerminalOptions
  watchedCheckouts: CheckoutToWatch[]
  confinementFailures: FreezeFailure[]
  frozenBefore: FrozenCheckout[]
  removeIsolatedCwd: (() => void) | null
  changes: Changes | null
  provisionedMcpConfig: { measure<T>(operation: () => T): T } | null
  started: number
  retargetDiagnostic: string | null
  error: string | null
  contract: WorkerReply | null
  status: string
  contractObjects: number
  vendorTerminatedStream: string | null
  acceptedQuestions: ReturnType<typeof realQuestions>
  requestedJob: Job
  output: string
  confinementEvent: ConfinementEvent | null
  resolvedDialect: ReplyDialect
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
  costUsd: number | null
  effectiveModel: string | null
  resolvedSession: string | null
  name: string
  artifactsPersisted: boolean
}

export type TerminalResult = {
  status: string
  error: string | null
  failureKind: ReturnType<typeof classify> | null
  changes: Changes | null
  output: string
  acceptedQuestions: ReturnType<typeof realQuestions>
  confinementEvent: ConfinementEvent | null
  preConfinement: string | null
  artifactsPersisted: boolean
}

/** Every writing turn gets one last chance to preserve tracked work. */
export function shouldCheckpointAtTerminal(input: {
  writesJob: boolean
  hasWorktree: boolean
  launchKey: string | null
}): boolean {
  return input.writesJob && input.hasWorktree && Boolean(input.launchKey)
}

/**
 * Record a parsed findings reply as review evidence in the terminal
 * transaction. Probe runs are calibration, not product evidence.
 */
export function recordTerminalReviewEvidence(
  database: Database,
  input: {
    runId: number
    parsedReview: ReviewReply | null
    status: string
    failureKind: ReturnType<typeof classify> | null
  },
): number | null {
  if (!input.parsedReview || (input.status !== 'ok' && input.failureKind !== 'escaped')) {
    return null
  }
  const row = database.query('SELECT probe FROM run WHERE id=?').get(input.runId) as {
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

export async function finishRun(input: TerminalInput): Promise<TerminalResult> {
  let {
    timer,
    checkpointTimer,
    idleTimer,
    proc,
    askLoopback,
    claim,
    writesJob,
    worktree,
    launchKey,
    failureKind,
    scratchDir,
    gitConfigEnvironment,
    opts,
    watchedCheckouts,
    confinementFailures,
    frozenBefore,
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
    output,
    confinementEvent,
    resolvedDialect,
    runProjectName,
    mcpConnection,
    mcpMode,
    declaredDeliverables,
    mcpSetupHeader,
    outPath,
    preConfinement,
    callerCwd,
    promptPath,
    exitCode,
    vendorTokens,
    costUsd,
    effectiveModel,
    resolvedSession,
    name,
    artifactsPersisted,
  } = input
  if (timer) clearTimeout(timer)
  if (checkpointTimer) clearInterval(checkpointTimer)
  if (idleTimer) clearInterval(idleTimer)
  if (proc) {
    live.delete(proc)
    liveCheckpoints.delete(proc)
  }
  if (proc?.pid && proc.pid !== process.pid) await terminateProcessGroup(proc.pid, { direct: proc })
  if (askLoopback) await askLoopback.close()
  await resetSandbox()

  const preserveAtTerminal = shouldCheckpointAtTerminal({
    writesJob,
    hasWorktree: Boolean(worktree),
    launchKey,
  })
  if (preserveAtTerminal) {
    const checkpoint = checkpointRun({
      database: db(),
      runId: claim.id,
      worktree: worktree!.path,
      branch: worktree!.branch,
      taskKey: launchKey!,
      scratchDir,
      guardEnvironment: gitConfigEnvironment ?? {},
      final: true,
    })
    if (checkpoint.created || latestCheckpoint(db(), opts.resume?.parent ?? claim.id)) {
      db().query('UPDATE run SET work_preserved=1 WHERE id=?').run(claim.id)
    }
    if (checkpoint.error)
      console.error(`orch: run ${claim.id} final checkpoint failed: ${checkpoint.error}`)
  }

  let frozenAfter: import('./confinement.ts').FrozenCheckout[] = []
  try {
    const afterFreeze = freezeCheckouts(watchedCheckouts)
    confinementFailures.push(
      ...afterFreeze.failures.map((failure) => ({
        ...failure,
        error: `after snapshot: ${failure.error}`,
      })),
    )
    frozenAfter = afterFreeze.snapshots
  } catch (e) {
    // A failure in the observation machinery itself cannot safely fabricate
    // which checkout was unreadable. Keep the original outcome and make the
    // harness fault visible; freeze failures take the binding path.
    console.error(`orch: could not freeze watched checkouts for run ${claim.id}: ${e}`)
  }

  // The directory contains no input and is useful only while the vendor is
  // alive. Remove it after readSession has had the chance to derive any
  // vendor-owned transcript location from cwd.
  removeIsolatedCwd?.()

  /**
   * The diff is read EVEN WHEN THE RUN FAILED, and that is the point.
   *
   * A worker that timed out or crashed half way through an implementation has
   * left the most interesting artefact this system produces: a partial change
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

  if (frozenBefore.length && frozenAfter.length && !confinementFailures.length) {
    const startedAt = db()
      .query('SELECT started_at, head_commit FROM run WHERE id=?')
      .get(claim.id) as { started_at: string; head_commit: string | null } | null
    confinementEvent = classifyDivergence({
      before: frozenBefore,
      after: frozenAfter,
      ownDiffPaths: changes?.files ?? [],
      chainRoot: startedAt?.head_commit ?? null,
      database: db(),
      startedAt: startedAt?.started_at ?? new Date(started).toISOString(),
    })
  }

  if (retargetDiagnostic) error = error ? `${error}\n${retargetDiagnostic}` : retargetDiagnostic
  const finalization = finalizeWorkerReply({
    reply: contract,
    measuredFiles: changes?.files ?? null,
    status: status as import('./outcome.ts').OutcomeStatus,
    failureKind,
    error,
    contractObjects,
  })
  ;({ status, failureKind, error } = finalization)
  /**
   * A raw stdout/stderr stream ending in a vendor termination marker means the
   * vendor killed the session. Whatever else the run appears to be — an ACP stop
   * reason, a schema mismatch, a parsed question, a worker contract reporting
   * done — is an artefact of a stream that was cut off. Vendor truncation
   * therefore outranks every vendor-derived classification. It does NOT outrank
   * confinement (escaped, confinement_unverified), which outranks everything by
   * existing design.
   */
  if (vendorTerminatedStream) {
    status = 'failed'
    error = errorTail(vendorTerminatedStream)
    failureKind = 'truncated'
    acceptedQuestions = []
  }
  let parsedReview: ReviewReply | null = null
  if (requestedJob.findings && output && (status === 'ok' || confinementEvent)) {
    parsedReview = resolvedDialect.parse(output).reply as ReviewReply | null
  }
  const ownProject = runProjectName ? projectByName(runProjectName) : undefined
  const ownMcpServer =
    mcpConnection?.server ??
    (ownProject ? (ownProject.settings.mcpServer ?? ownProject.name) : undefined)
  const otherProjectMcpServers = new Set(
    projects()
      .map((project) => project.settings.mcpServer ?? project.name)
      .filter((server) => server !== ownMcpServer && server !== 'orch' && server !== 'orch-ask'),
  )
  const cleanReview =
    parsedReview && status === 'ok' && confinementEvent?.classification !== 'overlapping'
      ? cleanReviewEvidence(claim.id, parsedReview)
      : null
  const evidenceAssessment = assessEvidence(
    { status, error, failureKind },
    {
      findingsJob: Boolean(requestedJob.findings),
      outputPresent: Boolean(output),
      reviewReply: parsedReview,
      confinementClassification: confinementEvent?.classification ?? null,
      cleanReview,
      otherProjectMcpServers,
      ownMcpServer,
      readerJob: isReaderJob(opts.job),
      declaredDeliverables,
      readerReply:
        status === 'ok' && isReaderJob(opts.job) && declaredDeliverables.length
          ? parseReaderOutput(output)
          : null,
    },
  )
  status = evidenceAssessment.status
  error = evidenceAssessment.error
  failureKind = evidenceAssessment.failureKind
  const provenanceWrongProjectTool = evidenceAssessment.provenanceWrongProjectTool

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
     * Matched on the question text, normalised, which is what the worker is
     * repeating verbatim from its own tool call.
     */
    const norm = (t: string) => t.trim().replace(/\s+/g, ' ').toLowerCase()
    const already = new Set(
      (
        db().query('SELECT question FROM question WHERE run_id = ?').all(claim.id) as {
          question: string
        }[]
      ).map((r) => norm(r.question)),
    )
    const q = db().query(
      `INSERT INTO question (run_id, asked_at, question, options, recommendation, why)
         VALUES (?,?,?,?,?,?)`,
    )
    for (const item of acceptedQuestions) {
      if (already.has(norm(item.question))) continue
      q.run(
        claim.id,
        nowIso(),
        item.question,
        item.options?.length ? JSON.stringify(item.options) : null,
        item.recommendation ?? null,
        item.why ?? null,
      )
      already.add(norm(item.question))
    }
  }

  if (mcpSetupHeader) {
    output = output ? `${mcpSetupHeader}\n\n${output}` : mcpSetupHeader
    writeFileSync(outPath, output)
  }

  // This post-process fact outranks every vendor exit or reply outcome. The
  // reply and diff remain stored, but an escaped write can never be an ok or
  // asking run and never inherits a failover-eligible vendor failure.
  if (confinementFailures.length) {
    preConfinement = JSON.stringify({ status, failureKind, error })
    status = 'failed'
    failureKind = 'confinement_unverified'
    error = confinementUnverifiedError(confinementFailures)
  } else if (confinementEvent?.classification === 'overlapping') {
    preConfinement = JSON.stringify({ status, failureKind, error })
    status = 'failed'
    failureKind = 'escaped'
    error = overlappingError(confinementEvent)
  }

  /**
   * BLOCKERS, from every job — not only the ones with a contract.
   *
   * The runs that reported these were review lenses, which carry no contract
   * at all, so a structured field alone would have caught none of them. What
   * they did was say it in prose and carry on, and nothing could count that.
   *
   * Declared and detected are stored side by side and kept distinguishable,
   * for the same reason measured and claimed facts are: one is the worker's
   * own account, the other is our reading of its prose, and a reader deserves
   * to know which they are looking at.
   */
  try {
    const rows: {
      what: string
      why: string
      impact: string | null
      source: string
      kind: string | null
    }[] = []
    for (const b of contract?.blockers ?? []) {
      /**
       * A DECLARED blocker gets a kind too, where we recognise one.
       *
       * `kind` is what makes recurrence countable, and a declared blocker had
       * none — so it grouped by its own prose, and two workers describing the
       * same denied socket in different words counted as two separate
       * problems. The detector already knows these shapes; run it over what
       * the worker wrote and use its answer when it finds one.
       *
       * Null when nothing matches, which is honest: an unrecognised blocker
       * is still worth recording, it just cannot be pooled with anything yet.
       */
      const [known] = detectBlockers(`${b.what}\n${b.why}`)
      rows.push({
        what: b.what,
        why: b.why,
        impact: b.impact ?? null,
        source: 'declared',
        kind: known?.kind ?? null,
      })
    }
    // Detected only where nothing was declared: a worker that filled the
    // field in has already told us, and adding our guess beside its answer
    // would double-count one blocker.
    if (!rows.length) {
      for (const d of detectBlockers(output)) {
        rows.push({ what: d.what, why: d.why, impact: null, source: 'detected', kind: d.kind })
      }
    }
    if (rows.length) {
      const q = db().query(
        `INSERT INTO blocker (run_id, at, what, why, impact, source, kind)
           VALUES (?,?,?,?,?,?,?)`,
      )
      for (const r of rows) q.run(claim.id, nowIso(), r.what, r.why, r.impact, r.source, r.kind)
    }
  } catch (e) {
    // Never let recording a blocker fail a run that otherwise succeeded.
    console.error(`orch: could not record blockers for run ${claim.id}: ${e}`)
  }

  const terminalSnapshot: TerminalSnapshot = {
    status,
    error,
    failureKind,
    output,
    outputPath: outPath,
    promptPath,
    exitCode,
    latencyMs: Date.now() - started,
    vendorTokens,
    vendorCostUsd: costUsd,
    model: effectiveModel,
    vendorSession: resolvedSession,
    preConfinement,
    confinement: confinementEvent ? JSON.stringify(confinementEvent) : null,
    filesChanged: writesJob ? (changes?.files.length ?? null) : null,
    changedPaths: writesJob && changes ? JSON.stringify(changes.files) : null,
    linesAdded: writesJob ? (changes?.insertions ?? null) : null,
    linesRemoved: writesJob ? (changes?.deletions ?? null) : null,
    testsRan: writesJob ? (contract?.tests ? (contract.tests.ran ? 1 : 0) : null) : null,
    testsPassed: writesJob
      ? contract?.tests?.passed === undefined
        ? null
        : contract.tests.passed
          ? 1
          : 0
      : null,
    deviations: writesJob ? (contract?.deviations?.length ?? null) : null,
    escalations: writesJob ? acceptedQuestions.length : null,
  }
  persistTerminalSnapshot(claim.id, terminalSnapshot)
  const reviewProvenance = parsedReview ? JSON.stringify(parsedReview.provenance) : null
  const provenanceSilent =
    parsedReview &&
    parsedReview.provenance.could_not_verify.length === 0 &&
    (parsedReview.provenance.substitutes.length > 0 ||
      (mcpMode !== null && mcpConnection?.connected !== true) ||
      Boolean(provenanceWrongProjectTool))
  const localMachineId = machineId()
  const writeTerminalRow = () =>
    writeTransaction(() => {
      const finishedAt = nowIso()
      db()
        .query(
          `UPDATE run SET latency_ms=?, exit_code=?, output_bytes=?, output_path=?, prompt_path=?,
                        vendor_tokens=?, vendor_cost_usd=?, model=COALESCE(?, model),
                        status=CASE WHEN status='stopped' THEN status ELSE ? END,
                        error=CASE WHEN status='stopped' THEN error ELSE ? END,
                        failure_kind=CASE WHEN status='stopped' THEN failure_kind ELSE ? END,
                        vendor_session=COALESCE(?, vendor_session), pre_confinement=?, confinement=?,
                        review_provenance=?, provenance_status=?,
                        unreconciled=0 WHERE id=?`,
        )
        .run(
          Date.now() - started,
          exitCode,
          new TextEncoder().encode(output).byteLength,
          outPath,
          promptPath,
          vendorTokens,
          costUsd,
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
                          tests_ran=?, tests_passed=?, deviations=?, escalations=? WHERE id=?`,
          )
          .run(
            changes?.files.length ?? null,
            changes ? JSON.stringify(changes.files) : null,
            changes?.insertions ?? null,
            changes?.deletions ?? null,
            contract?.tests ? (contract.tests.ran ? 1 : 0) : null,
            contract?.tests?.passed === undefined ? null : contract.tests.passed ? 1 : 0,
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
      if (opts.resume) {
        // A resumed turn that stopped to ask reopens the conversation: the root
        // goes back to asking with no failure kind, because the chain has not
        // ended. The resolver below only writes terminal outcomes, so an asking
        // turn must be rolled here or an ok/failed root would keep looking
        // finished while a question waits (lens run 2277).
        if (status === 'asking') {
          db()
            .query(
              `UPDATE run SET status='asking', error=?, failure_kind=NULL
              WHERE id=? AND parent_run_id IS NULL AND status NOT IN ('stopped', 'stale')`,
            )
            .run(error, opts.resume.parent)
        }
        resolveRootFromLastTurn(db(), opts.resume.parent)
      }

      // A parsed findings reply is the review event. Capture it in the same
      // terminal transaction so a successful lens cannot exist in the gap
      // between "ran" and "recorded". Probe traffic is calibration and is not
      // recorded. Manual `orch review record` remains the recovery path for
      // historical or otherwise uncaptured outputs.
      recordTerminalReviewEvidence(db(), {
        runId: opts.resume?.parent ?? claim.id,
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
            `UPDATE run SET unreconciled=1, error=? WHERE id=? AND status IN ('running','asking')`,
          )
          .run(
            `unreconciled: reply at ${runTerminalReplyPath(claim.id)}; ` +
              `cleared by: orch reconcile ${claim.id}  (${retry})`,
            claim.id,
          )
      } catch {
        /* the snapshot is on disk; the row write is what failed */
      }
      console.error(`orch: run ${claim.id} left unreconciled: ${detail}`)
    }
  }
  const recorded = db().query('SELECT status, failure_kind FROM run WHERE id=?').get(claim.id) as {
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
      resourceKey: event?.checkout ?? confinementFailures[0]?.path ?? callerCwd,
      eventKind: 'invalidation',
      cause: error,
      runId: claim.id,
    })
  }

  try {
    persistRunArtifacts(
      claim.id,
      isReaderJob(opts.job) ? (parseReaderOutput(output)?.files_written ?? null) : null,
      worktree,
      changes,
    )
  } catch (e) {
    artifactsPersisted = false
    status = 'failed'
    failureKind = 'harness'
    error = `artifact persistence failed for ${runArtifactsDir(claim.id)}: ${String((e as Error)?.message ?? e)}`
    db()
      .query(
        `UPDATE run SET
           status=CASE WHEN status='stopped' THEN status ELSE 'failed' END,
           error=CASE WHEN status='stopped' THEN error ELSE ? END,
           failure_kind=CASE WHEN status='stopped' THEN failure_kind ELSE 'harness' END
         WHERE id=?`,
      )
      .run(error, claim.id)
    if (opts.resume) resolveRootFromLastTurn(db(), opts.resume.parent)
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
