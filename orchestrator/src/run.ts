import { mkdirSync, readFileSync, existsSync, writeFileSync, } from 'node:fs'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  classify, notify, isNonAnswer, hasVendorTerminationMarker, detectBlockers, NEEDS_HUMAN, NEEDS_HUMAN_TITLE, FAILS_OVER, } from './failure.ts'
import {
  requireAgent, ensureLocalHealth, tryWake, minimumCliVersionRefusal, LOCAL_BASE_URL, } from './agents.ts'
import {
  job, isReaderJob, jobIdleKillMs, reclaimsTreeByDefault, resolveJobTimeoutMs, jobBoundInstruction, type Job, } from './jobs.ts'
import { pick } from './route.ts'
import { gitContext } from './git-environment.ts'
import {
  canonSourceFor, canonSourceInstruction, effectiveMcpRequest, mcpAttachRefusal, mcpRequestFromStored, requestedMcpMode, storedMcpRequest, type McpRequest, probeRequestedMcp, } from './mcp-preflight.ts'
import { preflight } from './dispatch-preflight.ts'
import {
  implicitReviewCoverageBase, resolveReviewTarget, } from './review-target.ts'
import { db, nowIso, sessionId, tryWriteContention, writableDb, writeTransaction, enableSchemaReload } from './db.ts'; import { resolveRootFromLastTurn } from './run-liveness.ts'; import { teardownTerminalRunResources } from './resource-ownership.ts'
import { toolFor } from './worktree-preflight.ts'; import { changesIn, type Changes } from './worktree-remove.ts'
import { resolveBase, resolveReadOnlyBase } from './worktree-caller.ts'; import { processStartTime } from './project-lock.ts'
import { prepareSharedRefGuard, assertSharedRefGuardOutsideWritableRoots, workerSharedGitRoots } from './ref-guard.ts'; import type { Worktree } from './worktree-types.ts'
import { prepareWorktreeObjects, targetGitEnvironment, contentTree, worktreeGitDir, type WorktreeObjectEnvironment } from './git-environment.ts'
import { checkoutWatchSet } from './checkout-identity.ts'
import { recipeNotes } from './recipe.ts'
import {
  workerPreamble, packResumePrompt, READONLY_PREAMBLE, NO_REPO_PREAMBLE,
  TEXT_REPLY_SCHEMA, REPLY_FILE_NAME, replyFileInstruction,
  REVIEW_SEVERITY_INSTRUCTION,
  resolveReplyDialect,
  isAsking, realQuestions, validatesSchema,
  parseReaderOutput,
  type CanonSource, type WorkerReply, type ReviewReply, type ReplyDialect,
} from './contract.ts'
import { cleanReviewEvidence } from './review.ts'
import {
  CALIBRATION_SUFFIX_RESERVE_BYTES, calibrationLine, reviewCalibration,
} from './review-calibration.ts'
import { projectAt, projectByName, projects, stackAt } from './projects.ts'
import { compilePack, recordPack } from './canon.ts'
import { resolveBranchRef } from './projects.ts'
import { resolveLens } from './lenses.ts'
import { TRUNCATED_TRANSCRIPT_BYTES } from './result-output.ts'
import { prepareSandboxHome, resetSandbox, sandboxLaunchArgv, selectReadonlySandbox } from './sandbox.ts'
import {
  classifyDivergence, freezeCheckouts, overlappingError,
  type ConfinementEvent, type FreezeFailure,
} from './confinement.ts'
import {
  mcpCallEvidence, mcpConfigAllowlist, namesSeenAt, probeMcpServer, readMcpConfig,
  storedMcpProbe, wrongProjectReason,
} from './mcp-probe.ts'
import { startAskLoopback, type AskLoopback } from './ask.ts'
import { receiptWorkerMessages, unreadWorkerMessages } from './mailbox.ts'
import {
  resolveTransportName, assertAcpAllowed, assertAcpReady, transportFor,
  selectAgentForTransport, isTestTransportInstalled, valueMatchesStrictSchema,
  schemaMismatchError, stopErrorMessage, failureKindFromStop,
  type TransportName, type TransportStartOpts, type TransportResult,
} from './transport.ts'
import { appendRunEvent, teeTransportEvents } from './events.ts'
import { codexMcpSetupHeader, codexProjectServersForRun } from './codex-mcp-scope.ts'
import { checkpointRun, DEFAULT_CHECKPOINT_MINUTES, latestCheckpoint, recordFailedIdlePreservation } from './checkpoint.ts'
import { decideOutcome, finalizeWorkerReply } from './outcome.ts'
import { assessEvidence, assessEvidencePrompt, recordEvidence } from './evidence.ts'
import {
  formatIdleKillError, idleKillMayProceed, idlePollMs,
  sampleProcesses, shouldIdleKill, terminateProcessGroup,
} from './idle-kill.ts'
import {
  chainTransport, decideFailover, failoverAttempts, failoverRefusalReason, failoverSuccessorAgent,
  MAX_FAILOVER_ATTEMPTS,
} from './failover.ts'
import {
  bindSignals, childEnv, errorTail, live, liveCheckpoints, sha, terminateRunProcesses,
} from './run-process.ts'
import {
  RUNS_DIR, persistRunArtifacts, persistTerminalSnapshot, pruneRuns,
  readDispatchState, runArtifactsDir, runFilePaths, runTerminalReplyPath,
  type TerminalSnapshot,
} from './run-artifacts.ts'
import { reclaimTerminalTree } from './close-out.ts'
import { claimRun } from './run-claim.ts'

export { TRUNCATED_TRANSCRIPT_BYTES }

export type RunResult = {
  id: number
  agent: string
  reason: string
  output: string
  latencyMs: number
  exitCode: number
  vendorTokens: number | null
  /** Only grok reports what a call cost; null everywhere else. */
  costUsd: number | null
  outPath: string
  /** Where a repository worker ran, and what it changed. Null for a non-repository job. */
  worktree: Worktree | null
  changes: Changes | null
  /** The worker's structured reply, when the job carried a contract. */
  contract: WorkerReply | null
  /** Terminal state, so a caller can tell `asking` from `ok` without re-reading the row. */
  status: string
}

/** Read-only repository jobs isolate scratch objects; writing jobs need durable commits. */
export function gitObjectEnvironmentFor(
  agent: string,
  requestedJob: Job,
  worktree: Worktree | null,
): WorktreeObjectEnvironment | undefined {
  return agent === 'codex' && requestedJob.needs.readsRepo && worktree &&
    !requestedJob.needs.writesRepo
    ? prepareWorktreeObjects(worktree.path)
    : undefined
}

function resolveRunTransport(opts: {
  transport?: TransportName
  resume?: { parent: number }
}): TransportName {
  if (opts.resume) {
    const inherited = chainTransport(opts.resume.parent)
    if (inherited) return inherited
  }
  return resolveTransportName(opts.transport)
}

export { resolveRootFromLastTurn }

function appendFailoverRefusal(id: number, reason: string): void {
  db().query(
    `UPDATE run SET error=COALESCE(error || '\n', '') || ? WHERE id=?`,
  ).run(`Failover refused: ${reason}`, id)
}


const CANON_SOURCE_PROMPT_RESERVE_BYTES = Math.max(
  ...(['live database', 'mirror', 'unknown'] as CanonSource[])
    .map((source) => Buffer.byteLength(canonSourceInstruction(source))),
) + 2

/**
 * Which project a directory belongs to, ASKED rather than inferred.
 *
 * This was `/Users/<someone>/Projects/<name>`, which is a fact about one
 * laptop written into the router. It worked, and it is also the single line
 * that made this tool unadoptable: nobody else's machine looks like that, and
 * the failure would be silent — an unrecognised layout yields `null`, which
 * reads as "no project" rather than as "this tool has never been told where
 * anything is".
 *
 * The register answers it now, by containment, so a worktree under
 * `<repo>/.claude/worktrees/orch-123` resolves to its project with no special
 * case at all — which the regex never did.
 */
export function repoOf(cwd: string): string | null {
  return projectAt(cwd)?.name ?? null
}

function reviewChangedPaths(cwd: string, base: string, inputTree: string): string[] {
  const args = ['diff', '--name-only', `${base}..${inputTree}`]
  const p = Bun.spawnSync(['git', '-C', cwd, ...args], {
    env: targetGitEnvironment(cwd), stdout: 'pipe', stderr: 'pipe',
  })
  if (p.exitCode !== 0) {
    throw new Error(
      `could not measure explicit review paths with git ${args.join(' ')}: ` +
      (p.stderr.toString().trim() || `exit ${p.exitCode}`),
    )
  }
  return p.stdout.toString().trim().split('\n').filter(Boolean)
}

/**
 * A pack is written before its disposable worktree exists, so callers naturally
 * name the checkout they are standing in. That path is an address, not review
 * content: once the tree has been copied, every occurrence must point at the
 * copy or an agent following the pack escapes the isolation boundary.
 */
function boundedConfinementError(message: string): string {
  const bytes = Buffer.from(message)
  if (bytes.length <= 1500) return message
  const suffix = Buffer.from('\n… [error bounded to 1500 bytes]')
  return Buffer.from(bytes.subarray(0, 1500 - suffix.length))
    .toString('utf8').replace(/\uFFFD$/, '') + suffix.toString()
}

function confinementUnverifiedError(failures: FreezeFailure[]): string {
  return boundedConfinementError(
    'checkout confinement could not be verified:\n' + failures.map((failure) =>
      `registered checkout ${failure.project} at ${failure.path}: ${failure.error}`,
    ).join('\n'),
  )
}

/** Present reply.json is accepted by the same lenient parsers as a missing-file fallback. */
function presentReplyFileMatches(opts: {
  text: string
  schema: unknown
  customSchema: boolean
  dialect: ReplyDialect
}): boolean {
  const schema = opts.schema as Parameters<typeof validatesSchema>[1]
  if (opts.customSchema) {
    let value: unknown
    try { value = JSON.parse(opts.text) } catch { return false }
    return validatesSchema(value, schema)
  }
  return opts.dialect.parse(opts.text).reply !== null
}

/**
 * The prompt a resumed turn actually puts on argv — reminder, separators,
 * resume guard, and the turn body — so the bound can be checked against the
 * same bytes the agent will receive.
 */
export function packedResumePrompt(job: string, turnPrompt: string, parentId: number): string {
  const root = db().query('SELECT prompt_path FROM run WHERE id=?').get(parentId) as
    { prompt_path: string | null } | null
  // A root whose prompt has aged out of runs/ (30 days) is still
  // resumable: the reminder is a courtesy to the worker, not a
  // precondition, and refusing here would strand the chain.
  if (!root?.prompt_path || !existsSync(root.prompt_path)) {
    return packResumePrompt(job, turnPrompt, null)
  }
  return packResumePrompt(job, turnPrompt, readFileSync(root.prompt_path, 'utf8'))
}

export async function run(opts: {
  job: string
  prompt: string
  agent?: string
  schemaPath?: string
  mcp?: McpRequest
  /** A calibration probe: recorded and scorable, but never routing evidence. */
  probe?: boolean
  /** A caller-supplied name for distinguishing sibling runs in a fan-out. */
  label?: string
  /** Stable identity used to calibrate findings-producing review jobs. */
  lens?: string
  model?: string
  /** Pilot opt-in. Default `cli`. */
  transport?: TransportName
  cwd?: string
  /** Explicit routing attribution when the caller is outside the registered project. */
  repo?: string
  /** The run this one re-attempts, for `orch retry`. */
  retryOf?: number
  noFailover?: boolean
  noWaitCapacity?: boolean
  ownerSession?: string | null
  automaticFailover?: boolean
  /**
   * How much database the worker's worktree gets, where the project asks.
   *
   * The ARCHITECT'S call, not the worker's, and not orch's. It depends on what
   * the task touches — docs need none, a migration needs every table, a report
   * needs the tables it reads — which is a fact about the design rather than
   * about the code, and the worker has not seen the design.
   */
  seed?: string
  /** A ticket key, where the project's branch convention requires one. */
  key?: string
  /** A caller-selected git floor, used only by lifecycle tools that accept it. */
  base?: string
  /** Fan-out diversity constraints, resolved by the CLI before a row exists. */
  avoid?: string[]
  distinctModels?: string[]
  /**
   * Carry the caller's uncommitted work into a newly cut worktree.
   *
   * Opt-in, default off. See the call site in this function for why.
   */
  carry?: boolean
  /** Branch or run id whose tip is the base of a findings review. */
  review?: string
  /**
   * A row already claimed by the caller, to be filled in rather than inserted.
   *
   * `orch do --detach` needs to print a run id BEFORE the work starts, which it
   * cannot do if the id is allocated in here after routing. So the caller
   * claims a placeholder row, hands the id over, and this fills it in once the
   * agent is picked.
   */
  reserveId?: number
  /**
   * Continue a worker that stopped to ask, instead of starting a new one.
   *
   * Threaded through `run()` rather than given its own function because
   * everything after the command line is identical — the same spawn, the same
   * timeout, the same reaping, the same `finally` that must write a terminal
   * row whatever happened. A second copy of that machinery would be a second
   * place for the bug this system has already had twice: a run that never says
   * it stopped.
   *
   * What a resume changes is only the front: no routing (the conversation
   * belongs to the agent that started it), no new worktree (the worker is
   * mid-edit in one), and `resumeArgv` in place of `argv`.
   */
  resume?: {
    parent: number
    agent: string
    session?: string
    /** Continue the chain and retained tree in a new vendor conversation. */
    fresh?: boolean
    turn: number
    /** Inherited so the chain stays owned by the session that started it. */
    sessionId: string | null
    worktree: Worktree | null
  }
  /** Declared reader deliverable names, from repeated `--deliverable`. */
  deliverables?: string[]
  /** `orch do --timeout` in minutes. */
  timeoutMinutes?: number
  /** Opt out of reclaim-at-terminalisation for lens and reader jobs. */
  keepTree?: boolean
  /** Immutable explicit-review target inherited only by automatic failover. */
  resolvedReviewTarget?: { branch: string; commit: string; base: string }
}): Promise<RunResult> {
  writableDb()
  enableSchemaReload(() => {})

  const requestedJob = job(opts.job), mcpRequest = effectiveMcpRequest(opts.mcp, requestedJob)
  const inheritedDispatch = opts.resume ? readDispatchState(opts.resume.parent) : null
  const declaredDeliverables = opts.deliverables ?? inheritedDispatch?.deliverables ?? []
  const timeoutMinutes = opts.timeoutMinutes ?? inheritedDispatch?.timeoutMinutes ?? undefined
  const writesJob = Boolean(requestedJob.needs.writesRepo)
  const repoJob = Boolean(requestedJob.needs.readsRepo)
  const forbidsRepo = requestedJob.needs.readsRepo === false
  const requestedTransport = resolveRunTransport(opts)
  const callerCwd = opts.cwd ?? process.cwd()
  const seed = preflight(
    opts.job, callerCwd, opts.seed, opts.key, opts.base,
    opts.resume?.worktree != null,
    opts.reserveId !== undefined,
    opts.lens, opts.resolvedReviewTarget ? undefined : opts.review, opts.carry, opts.repo,
  )
  const reviewTarget = opts.resolvedReviewTarget ?? resolveReviewTarget(
    opts.job, opts.cwd ?? process.cwd(), opts.review, opts.carry,
  )
  const implicitCoverageBase = !reviewTarget && requestedJob.findings
    ? implicitReviewCoverageBase(callerCwd)
    : null
  const coverageBase = reviewTarget?.base ?? implicitCoverageBase
  // Programmatic callers get the same ordering guarantee as the CLI: a bad
  // ref is refused before a run row or worktree exists.
  if (opts.base) {
    const internalRepositoryFailover = opts.automaticFailover && requestedJob.needs.readsRepo
    if (opts.job !== 'implement' && opts.job !== 'fix' && !internalRepositoryFailover) {
      throw new Error('--base is only valid for the implement and fix jobs')
    }
  }
  const readOnlyBase = repoJob && !writesJob && !opts.resume?.worktree
    ? resolveReadOnlyBase(callerCwd, reviewTarget?.commit ?? opts.base ?? 'HEAD')
    : null
  if (opts.base && readOnlyBase === null) resolveBase(callerCwd, opts.base)
  // REACHABILITY IS A ROUTING INPUT, not a run outcome, and this is the line
  // that makes it one. `available()` had only ever checked that an endpoint was
  // CONFIGURED, which stayed true while the local model host was powered off
  // — so routing kept handing it `file-question`, its best job, and kept
  // recording the failures against the model. One probe here costs 2ms when the
  // endpoint is healthy, and when it is not it replaces a run that was going to
  // fail anyway.
  //
  // Awaited before pick() so the router sees the result, and cached for the
  // process so a fan-out probes once rather than per run.
  const health = await ensureLocalHealth()
  // Down, so ask it to come back — and then carry on without it.
  //
  // A cold start is 5m42s measured (power-on to `Application startup complete`),
  // which no caller can wait for, so this is fire-and-continue: the packet goes
  // out, THIS job routes to a cloud agent as it would have anyway, and the next
  // one minutes later finds the endpoint up. Nothing is slower than it was; the
  // difference is that the outage now ends by itself.
  //
  // Opt-in via ORCH_LOCAL_WOL_MAC, because the box is shared and powering on
  // somebody else's machine is not a default worth assuming.
  if (!health.ok) {
    const woken = tryWake()
    if (woken.sent) {
      notify('waking the local box', `${woken.detail}. Serving again in ~6 minutes.`)
    }
  }
  /**
   * A writing job carries its role contract, and carries it HERE.
   *
   * The caller's prompt is stored unwrapped at prompt_path so `orch retry` can
   * re-send it and wrap once. The bound text — preamble plus prompt — is what
   * the agent is actually sent, hashed and routed, and is written beside it as
   * `.bound.txt`. Wrapping it further down would send a payload the database
   * no longer described.
   *
   * Whether a contract is required is derived from `writesRepo`: changing
   * files is where guessing becomes costly. Its role prose is selected by job,
   * because `land` deliberately permits the one commit that the ordinary
   * implementation contract forbids.
   */
  // A RESUMED turn does not repeat the full preamble. The worker is still inside
  // the conversation that carried it, so re-sending all of it would spend tokens
  // restating rules the agent is already operating under. A short reminder puts
  // the original plan back in view without storing another copy on every child.
  /**
   * The worker is TOLD about the infrastructure it has, in the project's own
   * words.
   *
   * A worker that does not know it can serve its own branch on its own port
   * verifies against whatever is already running — a different branch's bundle
   * — and that does not fail, it PASSES against the wrong tree. Which is worse
   * than failing, and is exactly the trap these projects wrote their worktree
   * scripts to close.
   */
  /**
   * What the worker is told about its tree — the project's own words where it
   * wrote them, and generated from the recipe where it did not.
   *
   * A project writing its own `notes` knows things bottega cannot. A project
   * that only declared a recipe should still not have to remember to warn a
   * worker never to verify against somebody else's server, so the facts bottega
   * does know are stated on its behalf.
   */
  const infra = (() => {
    if (!repoJob) return ''
    const tool = toolFor(opts.cwd ?? process.cwd())
    if (!tool) return ''
    if (!writesJob && (!tool.readonly_create || tool.readonly_notes !== undefined)) {
      const tree = tool.readonly_notes !== undefined
        ? `This read-only run has the project's files at ${readOnlyBase}. ${tool.readonly_notes}`
        : `This read-only run has the project's files at ${readOnlyBase} with NO provisioned ` +
          `infrastructure (no databases, no generated env, no vendor tree).`
      return `${tree} Do not treat a test suite that cannot start as a finding; ` +
        `record what you could not run in could_not_verify.`
    }
    const generated = tool.recipe
      ? recipeNotes(tool.recipe, '<this worktree\'s database>', '')
      : ''
    return [tool.notes ?? '', generated].filter(Boolean).join('\n\n')
  })()
  const originalPrompt = opts.prompt
  const resolvedDialect = resolveReplyDialect(requestedJob)
  const generatedSchema = resolvedDialect.schema
  const replySchemaName = opts.schemaPath
    ? basename(opts.schemaPath)
    : resolvedDialect.schemaName
  const runProjectName = opts.repo ?? repoOf(callerCwd)
  const runProjectId = runProjectName ? projectByName(runProjectName)?.id ?? null : null
  let pack: ReturnType<typeof compilePack> | null = null
  if (!opts.resume) {
    try {
      pack = compilePack({ job: opts.job, cwd: callerCwd })
      recordPack(pack)
    } catch (cause) {
      const message = (cause as Error).message
      let failedId = opts.reserveId
      if (failedId) db().query(
        `UPDATE run SET status='failed', failure_kind='harness', error=? WHERE id=?`,
      ).run(message, failedId)
      else failedId = (db().query(
        `INSERT INTO run (started_at,agent,job,repo,project_id,cwd,prompt_sha,spec_sha,prompt_bytes,prompt_head,
          status,session_id,failure_kind,error,docs_injected,mcp)
         VALUES (?,'(pending)',?,?,?,?,?,?,?,?,'failed',?,'harness',?,0,?) RETURNING id`,
      ).get(nowIso(), opts.job, runProjectName, runProjectId, callerCwd, sha(originalPrompt), sha(originalPrompt),
        Buffer.byteLength(originalPrompt), originalPrompt.slice(0, 200).replace(/\s+/g, ' '),
        opts.ownerSession ?? sessionId(), message, storedMcpRequest(mcpRequest)) as { id: number }).id
      throw Object.assign(new Error(`run ${failedId} could not start: ${message}`), { runId: failedId })
    }
  }
  const docsSection = pack?.docs.length
    ? `WHAT THE OPERATOR WANTS YOU TO KNOW\n\n${pack.markdown}`
    : ''
  let prompt = writesJob && (!opts.resume || opts.resume.fresh)
    ? [
        workerPreamble(opts.job),
        infra ? `\nYOUR WORKTREE'S INFRASTRUCTURE\n\n${infra}` : '',
        docsSection ? `\n${docsSection}` : '',
        `\n---\n\nTHE SPEC\n\n${originalPrompt}`,
      ].filter(Boolean).join('\n')
    // A read-only worker gets a much shorter brief, and only on a first turn.
    : opts.resume && !opts.resume.fresh
      ? packedResumePrompt(opts.job, originalPrompt, opts.resume.parent)
      : [repoJob ? READONLY_PREAMBLE : NO_REPO_PREAMBLE,
          infra ? `YOUR WORKTREE'S INFRASTRUCTURE\n\n${infra}` : '',
          docsSection, `---\n\n${originalPrompt}`]
          .filter(Boolean).join('\n\n')

  if (requestedJob.findings && (!opts.resume || opts.resume.fresh)) {
    prompt = `${REVIEW_SEVERITY_INSTRUCTION}\n\n${prompt}`
    const resolvedLens = resolveLens(opts.lens!, opts.repo ?? repoOf(callerCwd))
    if (resolvedLens) prompt += `\n\n${resolvedLens.body}`
    else console.error(`lens ${opts.lens}: no catalogue row; dispatching the free-form lens unchanged`)
  }
  const evidencePrompt = assessEvidencePrompt({
    findingsJob: Boolean(requestedJob.findings),
    verifyClaimJob: opts.job === 'verify-claim',
    readerJob: isReaderJob(opts.job),
    declaredDeliverables,
  })
  if (evidencePrompt.readerInstruction && (!opts.resume || opts.resume.fresh)) {
    prompt = `${evidencePrompt.readerInstruction}\n\n${prompt}`
  }
  prompt = `${replyFileInstruction(replySchemaName)}\n\n${prompt}`

  const requiresCanonSource = evidencePrompt.requiresCanonSource

  // A resumed turn is NOT routed. The conversation lives inside one vendor's
  // session, so "which agent is best at this job" is not a question that can be
  // asked any more — re-routing would resume a session the new agent has never
  // seen. Recorded with a reason that says so, rather than an empty one.
  const { agent: name, reason } = opts.resume
    ? {
        agent: opts.resume.agent,
        reason: `resumed run ${opts.resume.parent} (turn ${opts.resume.turn}); ` +
          'repository path retargeting not applied because the turn is already bound to its worktree',
      }
    // The STACK steers the route: an agent strong on PHP and weak on a Vue
    // component is two different agents to a router, and only this tells them
    // apart. Backs off to job-wide evidence until a stack cell has earned it.
    : pick(opts.job, selectAgentForTransport(requestedTransport, opts.agent),
           Buffer.byteLength(prompt) + (requestedJob.findings ? CALIBRATION_SUFFIX_RESERVE_BYTES : 0) +
             (requiresCanonSource ? CANON_SOURCE_PROMPT_RESERVE_BYTES : 0),
           true, stackAt(callerCwd),
           { agents: opts.avoid, models: opts.distinctModels, model: opts.model,
             noWaitCapacity: opts.noWaitCapacity },
           opts.probe, opts.lens)
  const a = requireAgent(name)
  let boundMs: number
  try {
    // A durable historical row can name an agent that is no longer registered.
    // Preserve the reserved resume row long enough for the existing harness
    // failure path to record that fact; timeout validation must not erase it.
    boundMs = resolveJobTimeoutMs(
      requestedJob,
      a?.timeoutMs ?? requestedJob.timeoutCeilingMs ?? 20 * 60_000,
      timeoutMinutes,
    )
  } catch (e) {
    if (opts.reserveId) db().query('DELETE FROM run WHERE id=?').run(opts.reserveId)
    throw e
  }
  if (!opts.resume) {
    const boundLine = `\n\n${jobBoundInstruction(requestedJob, boundMs)}`
    const split = prompt.lastIndexOf('\n---\n')
    prompt = split >= 0 ? prompt.slice(0, split) + boundLine + prompt.slice(split) : prompt + boundLine
  }
  const transportName = opts.resume || opts.transport !== undefined || process.env.ORCH_TRANSPORT
    ? requestedTransport
    : a.defaultTransport
  if (transportName === 'acp') {
    try {
      assertAcpAllowed(opts.job, name, a)
      if (!isTestTransportInstalled()) assertAcpReady(name, a)
    } catch (e) {
      if (opts.reserveId) db().query('DELETE FROM run WHERE id=?').run(opts.reserveId)
      throw e
    }
  }
  if (name === 'codex') {
    const versionRefusal = minimumCliVersionRefusal(a)
    if (versionRefusal) {
      if (opts.reserveId) db().query('DELETE FROM run WHERE id=?').run(opts.reserveId)
      throw new Error(versionRefusal)
    }
  }
  // Route first because the cell keys on the agent ACTUALLY selected. The
  // suffix reserve above keeps argv eligibility honest; append before any
  // prompt file, hash, or database prompt metadata is written.
  if (requestedJob.findings && !opts.resume) {
    const suffix = calibrationLine(reviewCalibration(opts.lens!, name, opts.model ?? a.model))
    if (Buffer.byteLength(suffix) > CALIBRATION_SUFFIX_RESERVE_BYTES) {
      throw new Error('review calibration line exceeded its reserved routing allowance')
    }
    prompt += `\n\n${suffix}`
  }

  /**
   * Probe after routing: a red grok doctor is evidence about grok, not about
   * Codex. Agents that discover MCP from cwd must be probed later, against the
   * worker tree they will actually inspect; all others retain the pre-row path.
   *
   * A reserved placeholder was claimed by detach() after the same check; if
   * routing here disagrees and grok cannot attach, delete that placeholder
   * rather than converting a non-event into a failed row.
   */
  const mcpMode = requestedMcpMode(mcpRequest)
  const deferredCwdMcpPreflight = Boolean(
    mcpMode && projectAt(callerCwd) && (forbidsRepo || (repoJob && a.caps.discoversMcpFromCwd)),
  )
  let mcpConnection = deferredCwdMcpPreflight
    ? null
    : probeRequestedMcp(mcpRequest, name, callerCwd)
  const mcpWhy = mcpConnection ? mcpAttachRefusal(mcpConnection) : null
  if (mcpWhy && mcpMode === 'require') {
    if (opts.reserveId) db().query('DELETE FROM run WHERE id=?').run(opts.reserveId)
    throw new Error(mcpWhy)
  }

  /** Whether the requested product is a diff, rather than review findings. */
  let usingMcp = (Boolean(mcpMode) || writesJob) && a.caps.mcp && mcpConnection?.connected !== false
  /**
   * Every repository job gets writable scratch space. `writesJob` still means
   * its requested product is a diff; `repoJob` means it needs an isolated tree
   * in which it may test a hypothesis.
   */
  const writes = repoJob

  // Minted before the spawn when the agent lets us choose, so the resume handle
  // exists even for a worker that dies mid-turn. codex and qwen name their own
  // and are read back afterwards instead.
  const vendorSession: string | null = opts.resume && !opts.resume.fresh
    ? opts.resume.session ?? null
    : a.mintSession?.() ?? null

  const runsDir = RUNS_DIR
  mkdirSync(runsDir, { recursive: true })
  pruneRuns(runsDir)
  /**
   * A RUN FILE IS NAMED BY ITS RUN, never by the clock alone.
   *
   * This was `${Date.now()}-${name}-${opts.job}`, and six review lenses fired
   * concurrently landed three of them inside the same millisecond with the same
   * agent and the same job — so three runs shared one prompt file and one output
   * file. Last write wins, so all three workers read whichever prompt was written
   * last and answered the same question; two of them were scored `none` by the
   * session that caught it, and it only caught it because the content did not
   * match what it had asked for.
   *
   * That is the worst shape a bug can have here: silent, confidently wrong, and
   * worse the more you parallelise — which is exactly the usage we encourage.
   * The run id is unique by construction, so it goes in the name. `claim` is the
   * reserved id for a detached run; a foreground run has none yet, and a random
   * suffix covers it without reintroducing a clock race.
   */
  const unique = opts.reserveId ?? `x${randomUUID().slice(0, 8)}`
  const paths = runFilePaths(runsDir, Date.now(), unique, name, opts.job)
  const stamp = paths.output.slice(runsDir.length + 1, -4)
  const outPath = paths.output
  let {
    promptPath, originalSchemaPath, textReplyContract, schemaPath, started, launchKey,
    runToken, claim, keepTree, scratchDir, worktree, changes,
    isolatedCwd, removeIsolatedCwd, provisionedMcpConfig, retargetDiagnostic,
    mcpSetupHeader, mcpTrustGranted, grokMcpEnvironment, sandboxRunDir, cwd,
    prompt: claimedBoundPrompt, mcpConnection: claimedMcpConnection,
    usingMcp: claimedUsingMcp,
  } = await claimRun({
    opts, runsDir, paths, stamp, name, generatedSchema, originalPrompt,
    prompt, callerCwd, seed, writesJob, repoJob, runProjectName, runProjectId,
    reason, vendorSession, pack, mcpRequest, transportName, a, mcpConnection,
    mcpMode, declaredDeliverables, timeoutMinutes, forbidsRepo, reviewTarget,
    coverageBase, readOnlyBase, deferredCwdMcpPreflight, usingMcp,
  })
  prompt = claimedBoundPrompt
  mcpConnection = claimedMcpConnection
  usingMcp = claimedUsingMcp

  // Read-only Codex jobs keep scratch objects in this worktree's metadata and
  // read existing objects through a common-store alternate. Writing jobs use
  // the common store so commits survive removal of the disposable tree.
  const gitObjectEnvironment = gitObjectEnvironmentFor(name, requestedJob, worktree)
  const writableRoots = [
    scratchDir,
    ...(repoJob && worktree
      ? [
          worktreeGitDir(worktree.path),
          ...(writesJob ? workerSharedGitRoots(worktree.path, worktree.branch) : []),
        ]
      : []),
  ]
  const gitConfigEnvironment = worktree
    ? prepareSharedRefGuard(
        worktree.path,
        writesJob && requestedJob.name !== 'land' ? `refs/heads/${worktree.branch}` : undefined,
      )
    : undefined
  if (gitConfigEnvironment) {
    assertSharedRefGuardOutsideWritableRoots(gitConfigEnvironment.GIT_CONFIG_VALUE_0, writableRoots)
  }
  const mcpConfig = readMcpConfig(cwd)
  const codexMcpScope = codexProjectServersForRun(name, transportName, usingMcp, mcpConfig, projectAt(callerCwd), cwd)
  mcpSetupHeader = codexMcpSetupHeader(mcpSetupHeader, codexMcpScope)
  const mcpServerName = mcpConnection?.server ?? projectAt(callerCwd)?.settings.mcpServer ?? projectAt(callerCwd)?.name ?? null
  const mcpAllowlist = mcpConfigAllowlist(mcpConfig)
  let sandboxSelection: ReturnType<typeof selectReadonlySandbox>
  try {
    sandboxSelection = selectReadonlySandbox({
      agent: name,
      readsRepo: repoJob,
      writesRepo: writesJob,
      worktree: worktree?.path ?? isolatedCwd,
      runsDir: sandboxRunDir,
      scratchDir,
      project: projectAt(callerCwd),
      readonlyNotes: toolFor(callerCwd)?.readonly_notes,
      override: process.env.ORCH_SANDBOX,
      path: process.env.PATH,
      localBaseUrl: LOCAL_BASE_URL,
      mcp: Boolean(mcpMode), mcpAllowlist: mcpMode ? mcpAllowlist : [],
    })
  } catch (e) {
    const why = String((e as Error)?.message ?? e)
    db().query(
      `UPDATE run SET status='failed', error=?, failure_kind='harness', latency_ms=? WHERE id=?`,
    ).run(why, Date.now() - started, claim.id)
    teardownTerminalRunResources(db(), claim.id)
    throw Object.assign(new Error(`run ${claim.id} could not start: ${why}`), { runId: claim.id })
  }
  const sandboxEnvironment = sandboxSelection.profile
    ? prepareSandboxHome(name, sandboxRunDir)
    : {}
  const sandboxRouteReason = sandboxSelection.reason
    ? `${reason}; sandbox host: ${sandboxSelection.reason}`
    : reason
  db().query('UPDATE run SET sandbox=?, route_reason=? WHERE id=?')
    .run(sandboxSelection.sandbox, sandboxRouteReason, claim.id)
  if (sandboxSelection.reason) {
    const header = `sandbox host: ${sandboxSelection.reason}`
    mcpSetupHeader = mcpSetupHeader ? `${mcpSetupHeader}\n${header}` : header
    console.error(`orch: run ${claim.id} ${header}`)
  }

  if (mcpMode && mcpServerName) {
    const probeConfig = mcpConfig[mcpServerName]
    if (probeConfig?.url || probeConfig?.command) {
      try {
        const projectSettings = projectAt(callerCwd)?.settings as
          { mcp?: { probe_tool?: string } } | undefined
        const probeTool = projectSettings?.mcp?.probe_tool ?? null
        const wrap = sandboxSelection.profile
          ? (bin: string, args: string[]) => sandboxLaunchArgv(sandboxSelection.profile!, bin, args)
          : undefined
        const probe = await probeMcpServer({
          server: mcpServerName,
          config: probeConfig,
          cwd,
          env: childEnv(a, claim.id, runToken, {
            ...(gitConfigEnvironment ?? {}), ...sandboxEnvironment, ...grokMcpEnvironment,
          }, repoJob),
          probeTool,
          wrap,
        })
        // The probe runs only when the required server is in .mcp.json, so the
        // wrong-project question is already answered; the doctor path asks it.
        const recorded = probe
        const callEvidence = mcpCallEvidence(recorded)
        db().query(
          'UPDATE run SET mcp_probe=?, mcp_connected=?, mcp_error=? WHERE id=?',
        ).run(storedMcpProbe(recorded), callEvidence.connected, callEvidence.error, claim.id)
        if (callEvidence.connected !== 1 && mcpMode === 'require') {
          const why = callEvidence.connected === 0
            ? `MCP tool call failed on ${mcpServerName}: ${callEvidence.error}`
            : `mcp unverifiable on ${name}: ${callEvidence.error}` +
              `\ninvariant: --mcp means a proven tool call, never a handshake` +
              `\ncleared by: orch project set ${projectAt(callerCwd)?.name ?? '<project>'} --settings '{"mcp":{"probe_tool":"<a cheap read tool on ${mcpServerName}>"}}'`
          db().query(
            `UPDATE run SET status='failed', error=?, failure_kind='mcp_unverified', latency_ms=? WHERE id=?`,
          ).run(why, Date.now() - started, claim.id)
          await resetSandbox()
          teardownTerminalRunResources(db(), claim.id)
          throw Object.assign(new Error(`run ${claim.id} could not start: ${why}`), { runId: claim.id })
        }
        if (!recorded.ok) {
          mcpConnection = {
            server: mcpServerName, connected: false, error: recorded.error,
            namesSeen: recorded.namesSeen,
          }
          db().query(
            `UPDATE run SET mcp_connected=0, mcp_error=? WHERE id=?`,
          ).run(recorded.error, claim.id)
          usingMcp = false
        }
      } catch (error) {
        if ((error as { runId?: number }).runId === claim.id) throw error
        const why = String((error as Error)?.message ?? error)
        db().query(
          `UPDATE run SET status='failed', error=?, failure_kind='harness', latency_ms=? WHERE id=?`,
        ).run(why, Date.now() - started, claim.id)
        await resetSandbox()
        teardownTerminalRunResources(db(), claim.id)
        throw Object.assign(new Error(`run ${claim.id} could not start: ${why}`), { runId: claim.id })
      }
    } else {
      const namesSeen = namesSeenAt(cwd)
      const mismatched = wrongProjectReason(mcpServerName, namesSeen)
      if (mismatched) {
        const recorded: import('./mcp-probe.ts').McpProbeResult = {
          server: mcpServerName,
          tool: 'tools/list',
          ok: false,
          error: mismatched,
          durationMs: 0,
          detail: null,
          namesSeen,
        }
        mcpConnection = {
          server: mcpServerName, connected: false, error: mismatched, namesSeen,
        }
        db().query(
          'UPDATE run SET mcp_connected=0, mcp_error=?, mcp_probe=? WHERE id=?',
        ).run(mismatched, storedMcpProbe(recorded), claim.id)
        if (mcpMode === 'require') {
          const why = mcpAttachRefusal(mcpConnection)!
          db().query(
            `UPDATE run SET status='failed', error=?, failure_kind='harness', latency_ms=? WHERE id=?`,
          ).run(why, Date.now() - started, claim.id)
          teardownTerminalRunResources(db(), claim.id)
          throw Object.assign(new Error(`run ${claim.id} could not start: ${why}`), { runId: claim.id })
        }
        mcpConnection = { ...mcpConnection, error: `mirror: ${mismatched}` }
        usingMcp = false
        db().query('UPDATE run SET mcp_error=? WHERE id=?').run(mcpConnection.error, claim.id)
      }
    }
  }

  if (requiresCanonSource) {
    prompt += `\n\n${canonSourceInstruction(canonSourceFor(true, mcpConnection, repoJob))}`
    writeFileSync(promptPath.replace(/\.prompt\.txt$/, '.bound.txt'), prompt)
    db().query('UPDATE run SET prompt_sha=?, prompt_bytes=? WHERE id=?')
      .run(sha(prompt), Buffer.byteLength(prompt), claim.id)
  }

  bindSignals()

  // Declared out here because the `finally` has to be able to write a terminal
  // row whatever happened inside: the row is already claiming to be running, and
  // the one thing worse than a failed run is one that never says it stopped.
  // Only the handle the signal path and the finally need. Typing it as the full
  // Subprocess would widen stdout/stderr back to "pipe or fd or nothing", which
  // is what the narrowed `p` inside the try exists to avoid.
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
  let artifactsPersisted = true
  let preConfinement: string | null = null
  let vendorTerminatedStream: string | null = null
  let confinementFailures: FreezeFailure[] = []
  let confinementEvent: ConfinementEvent | null = null
  let frozenBefore: import('./confinement.ts').FrozenCheckout[] = []
  let askLoopback: AskLoopback | null = null
  // Start after orch's own worktree and hook setup, immediately before the
  // vendor process. The interval establishes when a change happened, not who
  // wrote it: an architect or concurrent landing can change a watched checkout.
  const callerProject = projectAt(callerCwd)
  const callerCheckout = callerProject
    ? gitContext(callerCwd, 'rev-parse', '--show-toplevel') ?? callerCwd
    : null
  const callerWatch = callerCheckout && callerCheckout !== isolatedCwd
    ? [{ project: callerProject!.name, path: callerCheckout }]
    : []
  const candidates = checkoutWatchSet(
    callerWatch, worktree?.path, opts.repo ?? callerProject?.name ?? null,
  )
  const beforeFreeze = freezeCheckouts(candidates.watched)
  const skipped = [...candidates.failures, ...beforeFreeze.failures]
  // A detached child's stderr reaches nobody, so the skip also rides the output
  // header that `orch result` prints (lens run 2290): the register is stale and
  // the project unwatched on every later run until somebody reads this.
  const skipLines = skipped.map((failure) =>
    `confinement watch skipped ${failure.project} at ${failure.path}: ${failure.error}; ` +
    'fix the register with orch project set')
  for (const line of skipLines) console.error(line)
  if (skipLines.length) {
    mcpSetupHeader = mcpSetupHeader ? `${mcpSetupHeader}\n${skipLines.join('\n')}` : skipLines.join('\n')
  }
  frozenBefore = beforeFreeze.snapshots
  const watchedCheckouts = frozenBefore.map(({ project, path, expectedHead }) => ({
    project, path, expectedHead: expectedHead ?? undefined,
  }))

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
      const measured = db().query(
        'UPDATE run SET input_tree=?, head_commit=?, changed_paths=? WHERE id=?',
      ).run(inputTree, headCommit, changedPaths ? JSON.stringify(changedPaths) : null, claim.id)
      if (measured.changes !== 1) throw new Error(`run ${claim.id} could not record its input tree`)
    }
    if (sandboxSelection.sandbox === 'srt') {
      askLoopback = await startAskLoopback(claim.id, runToken)
    }
    const t = transportFor(transportName)
    const checkpointMessages = unreadWorkerMessages(claim.id)
    if (checkpointMessages.length) {
      const block = checkpointMessages.map((note) => `[message ${note.id}] ${note.body}`).join('\n\n') +
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
      session: transportName === 'acp' && !opts.resume?.fresh ? opts.resume?.session : vendorSession ?? undefined,
      schemaPath: schemaPath ?? undefined,
      model: opts.model ?? a.model,
      modelExplicit: opts.model !== undefined,
      home: sandboxEnvironment.HOME,
      startedAt: started,
      write: writes,
      sandbox: repoJob ? 'workspace-write' : 'read-only',
      mcp: usingMcp, mcpServer: mcpServerName ?? undefined, projectServers: codexMcpScope?.servers,
      trustCwd: mcpTrustGranted ? cwd : undefined,
      writableRoots,
      gitObjectEnvironment,
      gitConfigEnvironment,
      srt: sandboxSelection.profile
        ? { profile: sandboxSelection.profile, runtimeDir: sandboxRunDir }
        : undefined,
      resume: Boolean(opts.resume && !opts.resume.fresh),
      env: childEnv(a, claim.id, runToken, {
        ...(gitConfigEnvironment ?? {}), ...sandboxEnvironment, ...grokMcpEnvironment,
        ORCH_SCRATCH: scratchDir,
        ...(askLoopback ? { ORCH_ASK_URL: askLoopback.url } : {}),
      }, repoJob),
    }
    const handle = opts.resume?.session && !opts.resume.fresh
      ? await t.resume({ ...startOpts, session: opts.resume.session, resume: true })
      : await t.start(startOpts)
    proc = handle
    live.add(handle)
    effectiveModel = handle.effectiveModel ?? null
    if (effectiveModel) db().query('UPDATE run SET model=? WHERE id=?').run(effectiveModel, claim.id)
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
    const vendorSample = vendorPid && vendorPid > 1
      ? sampleProcesses().find((row) => row.pid === vendorPid)
      : undefined
    const vendorPgid = vendorSample && vendorSample.pgid > 1 ? vendorSample.pgid : null
    const vendorStartTime = vendorPid && vendorPid > 1 ? processStartTime(vendorPid) : null
    db().query(
      `UPDATE run SET agent_pid=?, agent_pgid=?, agent_start_time=?,
              last_event_at=COALESCE(last_event_at, ?) WHERE id=?`,
    ).run(vendorPid, vendorPgid, vendorStartTime, nowIso(), claim.id)

    const createCheckpoint = (final = false) => {
      if (!writesJob || !worktree || !launchKey) return null
      const result = checkpointRun({
        database: db(), runId: claim.id, worktree: worktree.path,
        branch: worktree.branch, taskKey: launchKey, scratchDir,
        guardEnvironment: gitConfigEnvironment ?? {}, final,
      })
      if (result.error) console.error(`orch: run ${claim.id} checkpoint failed: ${result.error}`)
      return result
    }
    if (writesJob) {
      checkpointTimer = setInterval(
        () => { createCheckpoint(false) },
        (requestedJob.checkpointMinutes ?? DEFAULT_CHECKPOINT_MINUTES) * 60_000,
      )
      if (worktree && launchKey) {
        liveCheckpoints.set(handle, {
          runId: claim.id, rootId: opts.resume?.parent ?? claim.id,
          worktree: worktree.path, branch: worktree.branch, taskKey: launchKey,
          scratchDir, guardEnvironment: gitConfigEnvironment ?? {},
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
      const row = db().query(
        'SELECT status, last_event_at, started_at FROM run WHERE id=?',
      ).get(claim.id) as { status: string; last_event_at: string | null; started_at: string } | null
      if (!row) return
      const openQuestion = db().query(
        'SELECT 1 n FROM question WHERE run_id=? AND answered_at IS NULL LIMIT 1',
      ).get(claim.id) as { n: number } | null
      const idleThresholdMs = jobIdleKillMs(opts.job, process.env, boundMs)
      const decision = shouldIdleKill({
        lastEventAt: row.last_event_at, startedAt: row.started_at, pid: handle.pid,
        asking: row.status === 'asking', openQuestion: Boolean(openQuestion),
        alreadyTimedOut: timedOut, alreadyIdleKilled: idleKilled,
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
      const afterCheckpoint = db().query(
        'SELECT status FROM run WHERE id=?',
      ).get(claim.id) as { status: string } | null
      const askedDuringCheckpoint = afterCheckpoint?.status === 'asking' || Boolean(
        db().query(
          'SELECT 1 n FROM question WHERE run_id=? AND answered_at IS NULL LIMIT 1',
        ).get(claim.id),
      )
      if (askedDuringCheckpoint) {
        idleKilled = false
        idleKillError = null
        appendRunEvent(claim.id, {
          ts: nowIso(), type: 'text',
          text: 'idle kill aborted: worker asked during checkpoint',
        })
        return
      }
      const prior = latestCheckpoint(db(), opts.resume?.parent ?? claim.id)
      if (!idleKillMayProceed(checkpoint, Boolean(prior))) {
        idleKilled = false
        idleKillError = null
        const why = checkpoint?.error ?? 'checkpoint failed'
        console.error(`orch: run ${claim.id} idle kill aborted: ${why}; no prior checkpoint, leaving the worker for the wall`)
        recordFailedIdlePreservation({
          runId: claim.id, scratchDir, worktree: worktree?.path ?? null, error: why,
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
          stdout: '', stderr: idleKillError, raw: '', parsed: null, output: '',
          tokens: null, costUsd: null, sessionId: null, stopReason: 'timeout',
          error: idleKillError, exitCode: -1, pid: handle.pid ?? 0,
          events: [], asking: false, failureKind: 'idle', status: 'failed', questions: [],
        })
      }
    }
    let idleCheckInFlight = false
    idleTimer = setInterval(() => {
      if (idleCheckInFlight || timedOut || idleKilled) return
      idleCheckInFlight = true
      void maybeIdleKill()
        .catch((error) => {
          console.error(`orch: run ${claim.id} idle check failed: ${error}`)
        })
        .finally(() => { idleCheckInFlight = false })
    }, idlePollMs(jobIdleKillMs(opts.job, process.env, boundMs)))

    const teeing = teeTransportEvents(handle.events(), claim.id)
    await t.prompt(handle, prompt)
    receiptWorkerMessages(claim.id, checkpointMessages.map((message) => message.id))
    const collected = await Promise.race([handle.collect(), forcedCollect])
    await teeing.catch(() => { /* the live log is observation, never outcome */ })
    const stdout = collected.stdout
    const stderr = collected.stderr
    // One derivation from the raw stream, carried through terminalisation.
    vendorTerminatedStream = [stdout, stderr].find(hasVendorTerminationMarker) ?? null
    exitCode = collected.exitCode
    const reply = collected.parsed
    const replyError = reply?.error ?? collected.error
    const outputCeilingReached = !!reply && !reply.text.trim() &&
      a.outputCeilingStopReason !== null && reply.stopReason === a.outputCeilingStopReason
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
      if (!presentReplyFileMatches({
        text: fileOutput,
        schema: validationSchema,
        customSchema: Boolean(opts.schemaPath),
        dialect: resolvedDialect,
      })) {
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
      } catch { /* Missing-file fallback may be the legacy plain-text result. */ }
      writeFileSync(outPath, output)
    }
    if (!replyFilePresent && opts.schemaPath) {
      let value: unknown
      try { value = JSON.parse(output) } catch { value = null }
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
      const line = `permission ${event.decision}: ${event.title}` +
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

    const completedReplyAtTimeout = contract?.status === 'done' ||
      (!writesJob && !replyError && !!output && !isNonAnswer(output))
    const acpVendorStop = transportName === 'acp' && collected.status === 'failed' &&
      Boolean(collected.stopReason && collected.stopReason !== 'end_turn')
    // A completed reply outranks an idle kill, exactly as the wall recovery
    // does: a parsed contract or a reply.json already on disk is finished work,
    // not an idle failure. Idle still outranks the transport stop reason so an
    // ACP/CLI cancel does not rewrite the kill as a timeout.
    const completedReply = completedReplyAtTimeout ||
      (replyFilePresent && !replyFileError && (contract?.status === 'done' || !writesJob))
    const acpFailureKind = collected.failureKind ??
      failureKindFromStop(collected.stopReason, collected.error)
    const replyErrorFailureKind = classify(
      replyError ?? '', exitCode, timedOut, sandboxSelection.sandbox,
    )
    const nonAnswer = exitCode === 0 && isNonAnswer(output)
    const nonAnswerFailureKind = classify(output, exitCode, timedOut, sandboxSelection.sandbox)
    const completedContractTerminal = stderr.trim() || stdout.trim()
    const completedContractFailureKind = classify(
      completedContractTerminal, exitCode, timedOut, sandboxSelection.sandbox,
    )
    const missingContractTerminal = stderr.trim() || output || stdout.trim()
    const classifiedMissingContract = classify(
      missingContractTerminal, exitCode, timedOut, sandboxSelection.sandbox,
    )
    const missingContractFailureKind = FAILS_OVER.includes(classifiedMissingContract)
      ? classifiedMissingContract
      : 'other'
    const defaultError = errorTail(stderr.trim() || stdout.trim() || `exit ${exitCode}, empty output`)
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
    } else if (acceptedQuestions.length) {
      // `asking`, not `blocked`: the worker is doing exactly what it was told
      // to. The word matters because a `blocker` in this system is the
      // opposite — an environment problem — and on a page they read alike.
      error = null
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
        (FAILS_OVER.includes(completedContractFailureKind) ? `${completedContractTerminal}\n` : '') +
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
  } finally {
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

    const recordedState = db().query('SELECT status FROM run WHERE id=?').get(claim.id) as
      { status: string } | null
    const preserveAtTerminal = writesJob && worktree && launchKey && (
      recordedState?.status === 'stopped' ||
      failureKind === 'timeout' || failureKind === 'idle' || failureKind === 'quota' || failureKind === 'context' || failureKind === 'cost'
    )
    if (preserveAtTerminal) {
      const checkpoint = checkpointRun({
        database: db(), runId: claim.id, worktree: worktree!.path,
        branch: worktree!.branch, taskKey: launchKey!, scratchDir,
        guardEnvironment: gitConfigEnvironment ?? {}, final: true,
      })
      if (checkpoint.created || latestCheckpoint(db(), opts.resume?.parent ?? claim.id)) {
        db().query('UPDATE run SET work_preserved=1 WHERE id=?').run(claim.id)
      }
      if (checkpoint.error) console.error(`orch: run ${claim.id} final checkpoint failed: ${checkpoint.error}`)
    }

    let frozenAfter: import('./confinement.ts').FrozenCheckout[] = []
    try {
      const afterFreeze = freezeCheckouts(watchedCheckouts)
      confinementFailures.push(...afterFreeze.failures.map((failure) => ({
        ...failure, error: `after snapshot: ${failure.error}`,
      })))
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
      const startedAt = (db().query('SELECT started_at, head_commit FROM run WHERE id=?').get(claim.id) as
        { started_at: string; head_commit: string | null } | null)
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
      reply: contract, measuredFiles: changes?.files ?? null,
      status: status as import('./outcome.ts').OutcomeStatus, failureKind, error, contractObjects,
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
    const ownMcpServer = mcpConnection?.server ??
      (ownProject ? ownProject.settings.mcpServer ?? ownProject.name : undefined)
    const otherProjectMcpServers = new Set(projects()
      .map((project) => project.settings.mcpServer ?? project.name)
      .filter((server) => server !== ownMcpServer && server !== 'orch' && server !== 'orch-ask'))
    const cleanReview = parsedReview && status === 'ok' &&
      confinementEvent?.classification !== 'overlapping'
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
        readerReply: status === 'ok' && isReaderJob(opts.job) && declaredDeliverables.length
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
        (db().query('SELECT question FROM question WHERE run_id = ?')
          .all(claim.id) as { question: string }[]).map((r) => norm(r.question)),
      )
      const q = db().query(
        `INSERT INTO question (run_id, asked_at, question, options, recommendation, why)
         VALUES (?,?,?,?,?,?)`,
      )
      for (const item of acceptedQuestions) {
        if (already.has(norm(item.question))) continue
        q.run(
          claim.id, nowIso(), item.question,
          item.options?.length ? JSON.stringify(item.options) : null,
          item.recommendation ?? null, item.why ?? null,
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
      const rows: { what: string; why: string; impact: string | null; source: string; kind: string | null }[] = []
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
          what: b.what, why: b.why, impact: b.impact ?? null,
          source: 'declared', kind: known?.kind ?? null,
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
      status, error, failureKind, output, outputPath: outPath, promptPath,
      exitCode, latencyMs: Date.now() - started,
      vendorTokens, vendorCostUsd: costUsd, model: effectiveModel,
      vendorSession: resolvedSession, preConfinement,
      confinement: confinementEvent ? JSON.stringify(confinementEvent) : null,
      filesChanged: writesJob ? changes?.files.length ?? null : null,
      changedPaths: writesJob && changes ? JSON.stringify(changes.files) : null,
      linesAdded: writesJob ? changes?.insertions ?? null : null,
      linesRemoved: writesJob ? changes?.deletions ?? null : null,
      testsRan: writesJob ? (contract?.tests ? (contract.tests.ran ? 1 : 0) : null) : null,
      testsPassed: writesJob
        ? (contract?.tests?.passed === undefined ? null : contract.tests.passed ? 1 : 0)
        : null,
      deviations: writesJob ? contract?.deviations?.length ?? null : null,
      escalations: writesJob ? acceptedQuestions.length : null,
    }
    persistTerminalSnapshot(claim.id, terminalSnapshot)
    const reviewProvenance = parsedReview ? JSON.stringify(parsedReview.provenance) : null
    const provenanceSilent = parsedReview && parsedReview.provenance.could_not_verify.length === 0 && (
      parsedReview.provenance.substitutes.length > 0 ||
      (mcpMode !== null && mcpConnection?.connected !== true) ||
      Boolean(provenanceWrongProjectTool)
    )
    const writeTerminalRow = () => writeTransaction(() => {
      db().query(
        `UPDATE run SET latency_ms=?, exit_code=?, output_bytes=?, output_path=?, prompt_path=?,
                        vendor_tokens=?, vendor_cost_usd=?, model=COALESCE(?, model),
                        status=CASE WHEN status='stopped' THEN status ELSE ? END,
                        error=CASE WHEN status='stopped' THEN error ELSE ? END,
                        failure_kind=CASE WHEN status='stopped' THEN failure_kind ELSE ? END,
                        vendor_session=COALESCE(?, vendor_session), pre_confinement=?, confinement=?,
                        review_provenance=?, provenance_status=?,
                        unreconciled=0 WHERE id=?`,
      ).run(
        Date.now() - started, exitCode, new TextEncoder().encode(output).byteLength, outPath, promptPath,
        vendorTokens, costUsd, effectiveModel, status, error, failureKind,
        resolvedSession, preConfinement,
        confinementEvent ? JSON.stringify(confinementEvent) : null,
        reviewProvenance, provenanceSilent ? 'silent' : null, claim.id,
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
        db().query(
          `UPDATE run SET files_changed=?, changed_paths=?, lines_added=?, lines_removed=?,
                          tests_ran=?, tests_passed=?, deviations=?, escalations=? WHERE id=?`,
        ).run(
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
          db().query(
            `UPDATE run SET status='asking', error=?, failure_kind=NULL
              WHERE id=? AND parent_run_id IS NULL AND status NOT IN ('stopped', 'stale')`,
          ).run(error, opts.resume.parent)
        }
        resolveRootFromLastTurn(db(), opts.resume.parent)
      }

      // A parsed findings reply is the review event. Capture it in the same
      // terminal transaction so a successful lens cannot exist in the gap
      // between "ran" and "recorded". Manual `orch review record` remains the
      // recovery path for historical or otherwise uncaptured outputs.
      if (parsedReview && (status === 'ok' || failureKind === 'escaped')) {
        recordEvidence(db(), opts.resume?.parent ?? claim.id, parsedReview)
      }
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
          db().query(
            `UPDATE run SET unreconciled=1, error=? WHERE id=? AND status IN ('running','asking')`,
          ).run(
            `unreconciled: reply at ${runTerminalReplyPath(claim.id)}; ` +
            `cleared by: orch reconcile ${claim.id}  (${retry})`,
            claim.id,
          )
        } catch { /* the snapshot is on disk; the row write is what failed */ }
        console.error(`orch: run ${claim.id} left unreconciled: ${detail}`)
      }
    }
    const recorded = db().query(
      'SELECT status, failure_kind FROM run WHERE id=?',
    ).get(claim.id) as { status: string; failure_kind: string | null } | null
    if (!recorded) {
      throw new Error(`run ${claim.id} disappeared before terminalisation`)
    }
    teardownTerminalRunResources(db(), claim.id)
    if (recorded.failure_kind === 'quota' || recorded.failure_kind === 'timeout') {
      tryWriteContention({
        resourceKind: 'vendor', resourceKey: name,
        eventKind: recorded.failure_kind === 'quota' ? 'refusal' : 'timeout',
        durationMs: Date.now() - started, cause: error, runId: claim.id,
      })
    } else if (recorded?.failure_kind === 'escaped' || recorded?.failure_kind === 'confinement_unverified') {
      const event = confinementEvent
      tryWriteContention({
        resourceKind: 'main_checkout',
        resourceKey: event?.checkout ?? confinementFailures[0]?.path ?? callerCwd,
        eventKind: 'invalidation',
        cause: error, runId: claim.id,
      })
    }

    try {
      persistRunArtifacts(
        claim.id,
        isReaderJob(opts.job) ? parseReaderOutput(output)?.files_written ?? null : null,
        worktree,
        changes,
      )
    } catch (e) {
      artifactsPersisted = false
      status = 'failed'
      failureKind = 'harness'
      error = `artifact persistence failed for ${runArtifactsDir(claim.id)}: ${String((e as Error)?.message ?? e)}`
      db().query(
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
  }

  // Quota and auth stop this agent working until a person acts. Notify at the
  // moment it happens even though the failover path below can route around it.
  if (failureKind && NEEDS_HUMAN.includes(failureKind)) {
    notify(
      NEEDS_HUMAN_TITLE[failureKind]?.(name) ?? `${name} needs attention`,
      `${opts.job} failed. Routing will avoid it until it succeeds again.`,
    )
  }
  if (idleUnkillable) {
    notify(
      `${name} idle kill did not terminate`,
      `run ${claim.id} still alive after SIGKILL; needs a human`,
    )
  }

  if (status === 'failed' && failureKind && FAILS_OVER.includes(failureKind)) {
    // The vendor is normally gone already. This is deliberately the same PID
    // termination primitive used by `orch stop`, excluding this coordinator:
    // it still has to route and run the successor before it may exit.
    terminateRunProcesses(claim.id, [process.pid])

    const attempts = failoverAttempts(claim.id)
    const tried = attempts.map((attempt) => attempt.agent)
    const first = db().query(
      `SELECT prompt_path, launch_cwd, launch_seed, launch_key, launch_base,
              no_failover, session_id, mcp, mcp_error, schema_path, probe, label, lens, repo,
              base_commit, head_commit, review_ref, transport
         FROM run WHERE id=?`,
    ).get(attempts[0]!.id) as {
      prompt_path: string | null; launch_cwd: string | null; launch_seed: string | null
      launch_key: string | null; launch_base: string | null; no_failover: number
      session_id: string | null; mcp: number | null; mcp_error: string | null; schema_path: string | null
      probe: number; label: string | null; lens: string | null; repo: string | null
      base_commit: string | null; head_commit: string | null; review_ref: string | null
      transport: TransportName | null
    }
    const treeName = worktree?.path ?? '(none — read-only job)'
    const failoverFacts = {
      status, failureKind, failoverKinds: FAILS_OVER,
      noFailover: Boolean(first.no_failover || opts.noFailover),
      writesJob, changes, worktree: treeName,
      attemptCount: attempts.length, maxAttempts: MAX_FAILOVER_ATTEMPTS,
      agentsTried: tried,
      originalPromptAvailable: Boolean(first.prompt_path && existsSync(first.prompt_path)),
    }
    const refusalReason = failoverRefusalReason(decideFailover(failoverFacts))
    if (refusalReason) {
      appendFailoverRefusal(claim.id, refusalReason)
    } else {
      try {
        const originalPrompt = readFileSync(first.prompt_path!, 'utf8')
        const selected = pick(
          opts.job, undefined,
          Buffer.byteLength(originalPrompt) + (requestedJob.findings ? CALIBRATION_SUFFIX_RESERVE_BYTES : 0), true,
          stackAt(first.launch_cwd ?? callerCwd),
          { agents: [...new Set([...(opts.avoid ?? []), ...tried])] },
          false,
          first.lens ?? undefined,
        )
        const successorAgent = failoverSuccessorAgent(
          decideFailover({ ...failoverFacts, successor: selected }),
        )
        console.error(
          `orch: run ${claim.id} failed over after ${name} ${failureKind}; ` +
          `starting the same prompt on ${successorAgent}`,
        )
        // The recursive successor has its own terminalisation path. Reclaim
        // this completed attempt before returning into it, otherwise this
        // frame never reaches the ordinary terminal reclaim below.
        if (artifactsPersisted && worktree && reclaimsTreeByDefault(opts.job)) {
          reclaimTerminalTree(claim.id, worktree, idleTreePids, idleTreePgid)
        }
        return await run({
          job: opts.job,
          prompt: originalPrompt,
          agent: successorAgent,
          transport: first.transport === 'cli' || first.transport === 'acp'
            ? first.transport : undefined,
          schemaPath: first.schema_path ?? undefined,
          mcp: mcpRequestFromStored(first.mcp, first.mcp_error),
          probe: !!first.probe,
          label: first.label ?? undefined,
          lens: first.lens ?? undefined,
          cwd: first.launch_cwd ?? callerCwd,
          repo: first.repo ?? undefined,
          retryOf: claim.id,
          noFailover: false,
          ownerSession: first.session_id,
          automaticFailover: true,
          seed: first.launch_seed ?? undefined,
          key: first.launch_key ?? undefined,
          // Every repository successor must recreate the first attempt's
          // immutable tree before carrying the same caller state. Falling back
          // to current trunk makes a review failover depend on a later move.
          base: repoJob ? (first.base_commit ?? first.launch_base ?? undefined) : undefined,
          avoid: opts.avoid,
          carry: opts.carry,
          review: first.review_ref ?? undefined,
          deliverables: declaredDeliverables,
          timeoutMinutes,
          keepTree,
          resolvedReviewTarget: first.review_ref && first.base_commit && first.head_commit
            ? {
                branch: resolveBranchRef(first.review_ref).branch,
                commit: first.head_commit,
                base: first.base_commit,
              }
            : undefined,
        })
      } catch (e) {
        const successor = db().query('SELECT id FROM run WHERE retry_of=?').get(claim.id)
        // Once a successor exists its own terminal row is the explanation.
        if (successor) throw e
        appendFailoverRefusal(claim.id, failoverRefusalReason(decideFailover({
          ...failoverFacts, selectionError: String((e as Error)?.message ?? e),
        }))!)
      }
    }
  }

  if (artifactsPersisted && worktree && reclaimsTreeByDefault(opts.job) &&
      status !== 'asking' && status !== 'running' && status !== 'stopped') {
    reclaimTerminalTree(claim.id, worktree, idleTreePids, idleTreePgid)
  }

  if (status === 'failed') {
    throw Object.assign(new Error(`run ${claim.id} failed: ${error}`), { runId: claim.id })
  }
  return {
    id: claim.id, agent: name, reason, output, latencyMs: Date.now() - started, exitCode,
    vendorTokens, costUsd, outPath, worktree, changes, contract, status,
  }
}
