import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { requireAgent } from '../agent/agent-registry.ts'
import { minimumCliVersionRefusal } from '../agent/agents.ts'
import { ensureLocalHealth, modelHostUrl, tryWake } from '../agent/model-host.ts'
import type { AskLoopback } from '../ask/ask.ts'
import { compilePack, recordPack } from '../canon/canon.ts'
import {
  type ConfinementEvent,
  type FreezeFailure,
  freezeCheckouts,
} from '../confinement/confinement.ts'
import {
  type CanonSource,
  NO_REPO_PREAMBLE,
  packResumePrompt,
  READONLY_PREAMBLE,
  REVIEW_SEVERITY_INSTRUCTION,
  type realQuestions,
  replyFileBytes,
  resolveReplyDialect,
  type WorkerReply,
  workerPreamble,
} from '../contract/contract.ts'
import {
  db,
  enableSchemaReload,
  nowIso,
  sessionId,
  writableDb,
  writeTransaction,
} from '../database/db.ts'
import { preflight } from '../dispatch/dispatch-preflight.ts'
import { assessEvidencePrompt } from '../evidence/evidence.ts'
import { type classify, notify } from '../failure/failure.ts'
import { checkoutWatchSet } from '../git/checkout-identity.ts'
import { gitContext, worktreeGitDir } from '../git/git-environment.ts'
import { isReaderJob, job, jobBoundInstruction, resolveJobTimeoutMs } from '../jobs/jobs.ts'
import { resolveLens } from '../lens/lenses.ts'
import {
  canonSourceFor,
  canonSourceInstruction,
  effectiveMcpRequest,
  type McpRequest,
  probeRequestedMcp,
  storedMcpRequest,
} from '../mcp/mcp-preflight.ts'
import {
  mcpConfigAllowlist,
  namesSeenAt,
  probeMcpServer,
  readMcpConfig,
  storedMcpProbe,
} from '../mcp/mcp-probe.ts'
import { projectAt, projectByName, stackAt } from '../project/projects.ts'
import { trackedRecipeEnvironment } from '../recipe/tracked-recipe.ts'
import { signedInRecordUserId } from '../record/record-attribution.ts'
import {
  assertSharedRefGuardOutsideWritableRoots,
  workerSharedGitRoots,
} from '../resources/ref-guard.ts'
import { recordSandboxDirectoryClaim } from '../resources/resource-claims.ts'
import { teardownTerminalRunResources } from '../resources/resource-ownership.ts'
import {
  CALIBRATION_SUFFIX_RESERVE_BYTES,
  calibrationLine,
  reviewCalibration,
} from '../review/review-calibration.ts'
import { implicitReviewCoverageBase, resolveReviewTarget } from '../review/review-target.ts'
import { chainTransport, type ResolvedTaskBranch } from '../route/failover.ts'
import { pick } from '../route/route.ts'
import { preflightCodexMcpCatalogues } from '../sandbox/codex-mcp-preflight.ts'
import { codexMcpSetupHeader, codexProjectServersForRun } from '../sandbox/codex-mcp-scope.ts'
import {
  prepareSandboxHome,
  resetSandbox,
  sandboxLaunchArgv,
  selectReadonlySandbox,
} from '../sandbox/sandbox.ts'
import {
  assertAcpAllowed,
  assertAcpReady,
  resolveTransportName,
  selectAgentForTransport,
  type TransportName,
} from '../transport/transport.ts'
import type { KeepTreeExemption } from '../worktree/keep-tree-hold.ts'
import { resolveBase, resolveReadOnlyBase } from '../worktree/worktree-caller.ts'
import { toolFor } from '../worktree/worktree-preflight.ts'
import type { Worktree } from '../worktree/worktree-types.ts'
import type { ResumeTreePlan } from './resume-tree.ts'
import {
  pruneRuns,
  RUNS_DIR,
  readDispatchState,
  runFilePaths,
  runScratchDir,
} from './run-artifacts.ts'
import { claimRun } from './run-claim.ts'
import { closeRun } from './run-close.ts'
import { codexAcpReadonlyDockerRefusal, decideCodexSandbox } from './run-codex-sandbox.ts'
import { workerGitConfigEnvironment } from './run-git-guard.ts'
import { decideRunLaunch } from './run-launch.ts'
import { acquireRunLease } from './run-lease.ts'
import { runLive } from './run-live.ts'
import * as mcpAttachment from './run-mcp-attachment.ts'
import { bindSignals, childEnv, sha } from './run-process.ts'
import { runInfrastructurePrompt } from './run-readonly-infrastructure.ts'
import { finishRun } from './run-terminal.ts'
import type { RunResult } from './run-types.ts'

async function startedByForRun(reserveId: number | undefined): Promise<string | null> {
  if (reserveId !== undefined) return null
  return signedInRecordUserId()
}

function requiredRunLease(
  runId: number,
  failed: (cause: unknown) => void,
): ReturnType<typeof acquireRunLease> {
  try {
    return acquireRunLease(runId)
  } catch (cause) {
    failed(cause)
    throw cause
  }
}

function throwPreclaimRefusal(refusal: string | null, reserveId: number | undefined): void {
  if (!refusal) return
  if (reserveId) db().query('DELETE FROM run WHERE id=?').run(reserveId)
  throw new Error(refusal)
}

/** From the run's recorded recipe, never a second register read that can differ from the one that built the tree. */
function trackedWorkerEnvironment(
  repoJob: boolean,
  writesJob: boolean,
  worktree: Worktree | null,
  runId: number,
): Record<string, string> {
  return {
    ...(writesJob && worktree ? trackedRecipeEnvironment(runId) : {}),
    ...(repoJob && worktree ? { ORCH_MAIN_CHECKOUT: worktree.repoRoot } : {}),
  }
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

const CANON_SOURCE_PROMPT_RESERVE_BYTES =
  Math.max(
    ...(['live database', 'mirror', 'unknown'] as CanonSource[]).map((source) =>
      Buffer.byteLength(canonSourceInstruction(source)),
    ),
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

function readOnlyBaseProjectPath(repo: string | undefined, callerCwd: string): string | null {
  return ((repo ? projectByName(repo) : null) ?? projectAt(callerCwd))?.path ?? null
}

/**
 * A pack is written before its disposable worktree exists, so callers naturally
 * name the checkout they are standing in. That path is an address, not review
 * content: once the tree has been copied, every occurrence must point at the
 * copy or an agent following the pack escapes the isolation boundary.
 */
/** Present reply.json is accepted by the same lenient parsers as a missing-file fallback. */
/**
 * The prompt a resumed turn actually puts on argv — reminder, separators,
 * resume guard, and the turn body — so the bound can be checked against the
 * same bytes the agent will receive.
 */
export function packedResumePrompt(job: string, turnPrompt: string, parentId: number): string {
  const root = db().query('SELECT prompt_path FROM run WHERE id=?').get(parentId) as {
    prompt_path: string | null
  } | null
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
  /** Shell directory that launched the root run, before implicit caller resolution. */
  launchCwd?: string
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
  /** The task branch resolution already performed by dispatch for this launch. */
  resolvedTaskBranch?: ResolvedTaskBranch | null
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
    treePlan?: Extract<ResumeTreePlan, { action: 'recreate-on-branch' | 'recreate-then-restore' }>
  }
  /** Declared reader deliverable names, from repeated `--deliverable`. */
  deliverables?: string[]
  /** `orch do --timeout` in minutes. */
  timeoutMinutes?: number
  /** Opt out of reclaim-at-terminalisation for lens and reader jobs. */
  keepTree?: KeepTreeExemption
  /** Immutable explicit-review target inherited only by automatic failover. */
  resolvedReviewTarget?: { branch: string; commit: string; base: string }
}): Promise<RunResult> {
  writableDb()
  enableSchemaReload(() => {})
  const startedByUserId = await startedByForRun(opts.reserveId)

  const requestedJob = job(opts.job),
    mcpRequest = effectiveMcpRequest(opts.mcp, requestedJob)
  const inheritedDispatch = opts.resume ? readDispatchState(opts.resume.parent) : null
  const declaredDeliverables = opts.deliverables ?? inheritedDispatch?.deliverables ?? []
  const timeoutMinutes = opts.timeoutMinutes ?? inheritedDispatch?.timeoutMinutes ?? undefined
  const writesJob = Boolean(requestedJob.needs.writesRepo)
  const repoJob = Boolean(requestedJob.needs.readsRepo)
  const forbidsRepo = requestedJob.needs.readsRepo === false
  const requestedTransport = resolveRunTransport(opts)
  const callerCwd = opts.cwd ?? process.cwd()
  const registeredWorktreeTool = toolFor(callerCwd)
  const seed = preflight(
    opts.job,
    callerCwd,
    opts.seed,
    opts.key,
    opts.base,
    opts.resume != null,
    opts.reserveId !== undefined,
    opts.lens,
    opts.resolvedReviewTarget ? undefined : opts.review,
    opts.carry,
    opts.repo,
  )
  const reviewTarget =
    opts.resolvedReviewTarget ??
    resolveReviewTarget(opts.job, opts.cwd ?? process.cwd(), opts.review, opts.carry)
  const implicitCoverageBase =
    !reviewTarget && requestedJob.findings ? implicitReviewCoverageBase(callerCwd) : null
  const coverageBase = reviewTarget?.base ?? implicitCoverageBase
  // Programmatic callers get the same ordering guarantee as the CLI: a bad
  // ref is refused before a run row or worktree exists.
  if (opts.base) {
    const internalRepositoryFailover = opts.automaticFailover && requestedJob.needs.readsRepo
    if (opts.job !== 'implement' && opts.job !== 'fix' && !internalRepositoryFailover) {
      throw new Error('--base is only valid for the implement and fix jobs')
    }
  }
  const requestedReadOnlyBase = reviewTarget?.commit ?? opts.base ?? 'HEAD'
  const readOnlyBase =
    repoJob && !writesJob && !opts.resume?.worktree
      ? resolveReadOnlyBase(
          callerCwd,
          requestedReadOnlyBase,
          opts.automaticFailover,
          readOnlyBaseProjectPath(opts.repo, callerCwd),
        )
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
  // Opt-in via ORCH_MODEL_HOST_WOL_MAC, because the box is shared and powering on
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
  const infra = runInfrastructurePrompt({
    tool: registeredWorktreeTool,
    callerCwd,
    readsRepo: repoJob,
    writesRepo: writesJob,
    readOnlyBase,
  })
  const originalPrompt = opts.prompt
  const resolvedDialect = resolveReplyDialect(requestedJob)
  const generatedSchema = resolvedDialect.schema
  const replySchemaName = opts.schemaPath ? basename(opts.schemaPath) : resolvedDialect.schemaName
  const runProjectName = opts.repo ?? repoOf(callerCwd)
  const runProjectId = runProjectName ? (projectByName(runProjectName)?.id ?? null) : null
  let pack: ReturnType<typeof compilePack> | null = null
  if (!opts.resume) {
    try {
      pack = compilePack({ job: opts.job, cwd: callerCwd })
      recordPack(pack)
    } catch (cause) {
      const message = (cause as Error).message
      let failedId = opts.reserveId
      if (failedId)
        db()
          .query(`UPDATE run SET status='failed', failure_kind='harness', error=? WHERE id=?`)
          .run(message, failedId)
      else
        failedId = (
          db()
            .query(
              `INSERT INTO run (started_at,agent,job,repo,project_id,cwd,prompt_sha,spec_sha,prompt_bytes,prompt_head,
          status,session_id,failure_kind,error,docs_injected,mcp,started_by_user_id)
         VALUES (?,'(pending)',?,?,?,?,?,?,?,?,'failed',?,'harness',?,0,?,?) RETURNING id`,
            )
            .get(
              nowIso(),
              opts.job,
              runProjectName,
              runProjectId,
              callerCwd,
              sha(originalPrompt),
              sha(originalPrompt),
              Buffer.byteLength(originalPrompt),
              originalPrompt.slice(0, 200).replace(/\s+/g, ' '),
              opts.ownerSession ?? sessionId(),
              message,
              storedMcpRequest(mcpRequest),
              startedByUserId,
            ) as { id: number }
        ).id
      throw Object.assign(new Error(`run ${failedId} could not start: ${message}`), {
        runId: failedId,
      })
    }
  }
  const docsSection = pack?.docs.length
    ? `WHAT THE OPERATOR WANTS YOU TO KNOW\n\n${pack.markdown}`
    : ''
  let prompt =
    writesJob && (!opts.resume || opts.resume.fresh)
      ? [
          workerPreamble(opts.job),
          infra ? `\nYOUR WORKTREE'S INFRASTRUCTURE\n\n${infra}` : '',
          docsSection ? `\n${docsSection}` : '',
          `\n---\n\nTHE SPEC\n\n${originalPrompt}`,
        ]
          .filter(Boolean)
          .join('\n')
      : // A read-only worker gets a much shorter brief, and only on a first turn.
        opts.resume && !opts.resume.fresh
        ? packedResumePrompt(opts.job, originalPrompt, opts.resume.parent)
        : [
            repoJob ? READONLY_PREAMBLE : NO_REPO_PREAMBLE,
            infra ? `YOUR WORKTREE'S INFRASTRUCTURE\n\n${infra}` : '',
            docsSection,
            `---\n\n${originalPrompt}`,
          ]
            .filter(Boolean)
            .join('\n\n')

  if (requestedJob.findings && (!opts.resume || opts.resume.fresh)) {
    prompt = `${REVIEW_SEVERITY_INSTRUCTION}\n\n${prompt}`
    const resolvedLens = resolveLens(opts.lens!, opts.repo ?? repoOf(callerCwd))
    if (resolvedLens) prompt += `\n\n${resolvedLens.body}`
    else
      console.error(`lens ${opts.lens}: no catalogue row; dispatching the free-form lens unchanged`)
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
  const requiresCanonSource = evidencePrompt.requiresCanonSource
  const pickSource = () =>
    pick(
      opts.job,
      selectAgentForTransport(requestedTransport, opts.agent),
      Buffer.byteLength(prompt) +
        replyFileBytes(replySchemaName, runScratchDir(Number.MAX_SAFE_INTEGER)) +
        (requestedJob.findings ? CALIBRATION_SUFFIX_RESERVE_BYTES : 0) +
        (requiresCanonSource ? CANON_SOURCE_PROMPT_RESERVE_BYTES : 0),
      true,
      stackAt(callerCwd),
      {
        agents: opts.avoid,
        models: opts.distinctModels,
        model: opts.model,
        noWaitCapacity: opts.noWaitCapacity,
      },
      opts.probe,
      opts.lens,
    )
  const source = opts.resume
    ? { source: 'resume' as const, ...opts.resume }
    : { source: 'pick' as const, ...pickSource() }
  const launch = decideRunLaunch({
    ...source,
    explicitTransport: opts.transport !== undefined,
    envTransport: Boolean(process.env.ORCH_TRANSPORT),
  })
  const a = requireAgent(launch.agent)
  const transportName = launch.useRequestedTransport ? requestedTransport : a.defaultTransport
  const { agent: name, reason } = launch
  const codexSandboxFacts = {
    agentIsCodex: name === 'codex',
    readsRepo: repoJob,
    writesRepo: writesJob,
    readonlyDocker: registeredWorktreeTool?.readonly_docker === true,
  }
  const codexSandbox = decideCodexSandbox(codexSandboxFacts)
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
    prompt =
      split >= 0 ? prompt.slice(0, split) + boundLine + prompt.slice(split) : prompt + boundLine
  }
  const transportRefusal = codexAcpReadonlyDockerRefusal({
    ...codexSandboxFacts,
    transport: transportName,
    projectName: runProjectName ?? 'unknown',
  })
  throwPreclaimRefusal(transportRefusal, opts.reserveId)
  if (transportName === 'acp') {
    try {
      assertAcpAllowed(opts.job, name, a)
      assertAcpReady(name, a)
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

  const callerCwdHasProject = Boolean(projectAt(callerCwd))
  const deferredCwdMcpPreflight = mcpAttachment.shouldDeferCwdMcpPreflight({
    mcpRequest,
    callerCwdHasProject,
    forbidsRepo,
    repoJob,
    discoversMcpFromCwd: a.caps.discoversMcpFromCwd,
  })
  let mcpConnection = deferredCwdMcpPreflight
    ? null
    : probeRequestedMcp(mcpRequest, name, callerCwd)
  const attachmentRuling = mcpAttachment.decideMcpAttachment({
    connection: mcpConnection,
    mcpRequest,
    writesJob,
    agentHasMcp: a.caps.mcp,
  })
  if (attachmentRuling.refusalReason) {
    // A routing mismatch must not convert the reserved placeholder into a failed row.
    if (opts.reserveId) db().query('DELETE FROM run WHERE id=?').run(opts.reserveId)
    throw new Error(attachmentRuling.refusalReason)
  }

  const mcpMode = attachmentRuling.mcpMode
  let usingMcp = attachmentRuling.usingMcp
  // Every repository job gets writable scratch; only `writesJob` requests a diff.
  const writes = repoJob

  // Minted before the spawn when the agent lets us choose, so the resume handle
  // exists even for a worker that dies mid-turn. codex and qwen name their own
  // and are read back afterwards instead.
  const vendorSession: string | null =
    opts.resume && !opts.resume.fresh ? (opts.resume.session ?? null) : (a.mintSession?.() ?? null)

  mkdirSync(RUNS_DIR, { recursive: true })
  pruneRuns(RUNS_DIR)
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
  const paths = runFilePaths(RUNS_DIR, Date.now(), unique, name, opts.job)
  const stamp = paths.output.slice(RUNS_DIR.length + 1, -4)
  const outPath = paths.output
  let {
    promptPath,
    originalSchemaPath,
    textReplyContract,
    schemaPath,
    started,
    launchKey,
    runToken,
    claim,
    keepTree,
    scratchDir,
    worktree,
    changes,
    isolatedCwd,
    removeIsolatedCwd,
    provisionedMcpConfig,
    retargetDiagnostic,
    mcpSetupHeader,
    mcpTrustGranted,
    grokMcpEnvironment,
    sandboxRunDir,
    cwd,
    prompt: claimedBoundPrompt,
    mcpConnection: claimedMcpConnection,
    usingMcp: claimedUsingMcp,
  } = await claimRun({
    opts,
    runsDir: RUNS_DIR,
    paths,
    stamp,
    name,
    generatedSchema,
    originalPrompt,
    prompt,
    callerCwd,
    seed,
    writesJob,
    repoJob,
    runProjectName,
    runProjectId,
    reason,
    vendorSession,
    pack,
    mcpRequest,
    transportName,
    a,
    mcpConnection,
    mcpMode,
    declaredDeliverables,
    timeoutMinutes,
    forbidsRepo,
    reviewTarget,
    coverageBase,
    readOnlyBase,
    deferredCwdMcpPreflight,
    usingMcp,
    startedByUserId,
    replySchemaName,
  })
  prompt = claimedBoundPrompt
  mcpConnection = claimedMcpConnection
  usingMcp = claimedUsingMcp

  // A reader clone keeps all writable Git metadata inside its own tree. Its
  // hooks live outside that root so the worker cannot disable the push guard.
  // Writers remain linked worktrees and retain their existing shared roots.
  const writableRoots = [
    scratchDir,
    ...(repoJob && worktree && writesJob
      ? [worktreeGitDir(worktree.path), ...workerSharedGitRoots(worktree.path, worktree.branch)]
      : []),
  ]
  const gitConfigEnvironment = workerGitConfigEnvironment(worktree, writesJob, requestedJob.name)
  const recipeEnvironment = trackedWorkerEnvironment(repoJob, writesJob, worktree, claim.id)
  if (gitConfigEnvironment) {
    assertSharedRefGuardOutsideWritableRoots(gitConfigEnvironment.GIT_CONFIG_VALUE_0, writableRoots)
  }
  const mcpConfig = readMcpConfig(cwd)
  const codexMcpScope = codexProjectServersForRun(
    name,
    transportName,
    usingMcp,
    mcpConfig,
    projectAt(callerCwd),
    cwd,
  )
  const mcpServerName =
    mcpConnection?.server ??
    projectAt(callerCwd)?.settings.mcpServer ??
    projectAt(callerCwd)?.name ??
    null
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
      readonlyDocker: registeredWorktreeTool?.readonly_docker === true,
      override: process.env.ORCH_SANDBOX,
      path: process.env.PATH,
      localBaseUrl: modelHostUrl(),
      mcp: Boolean(mcpMode),
      mcpAllowlist: mcpMode ? mcpAllowlist : [],
    })
  } catch (e) {
    const why = String((e as Error)?.message ?? e)
    db()
      .query(
        `UPDATE run SET status='failed', error=?, failure_kind='harness', latency_ms=? WHERE id=?`,
      )
      .run(why, Date.now() - started, claim.id)
    teardownTerminalRunResources(db(), claim.id)
    throw Object.assign(new Error(`run ${claim.id} could not start: ${why}`), { runId: claim.id })
  }
  const sandboxEnvironment = sandboxSelection.profile ? prepareSandboxHome(name, sandboxRunDir) : {}
  const mcpEnvironment = childEnv(
    a,
    claim.id,
    runToken,
    { ...(gitConfigEnvironment ?? {}), ...sandboxEnvironment, ...grokMcpEnvironment },
    repoJob,
  )
  const codexMcpCatalogues = await preflightCodexMcpCatalogues(codexMcpScope, mcpEnvironment)
  mcpSetupHeader = codexMcpSetupHeader(mcpSetupHeader, codexMcpScope, codexMcpCatalogues)
  const sandboxRouteReason = sandboxSelection.reason
    ? `${reason}; sandbox host: ${sandboxSelection.reason}`
    : reason
  writeTransaction(() => {
    db()
      .query('UPDATE run SET sandbox=?, route_reason=? WHERE id=?')
      .run(sandboxSelection.sandbox, sandboxRouteReason, claim.id)
    if (sandboxSelection.profile) {
      const rootRunId = (
        db()
          .query('SELECT COALESCE(parent_run_id,id) root_id FROM run WHERE id=?')
          .get(claim.id) as {
          root_id: number
        }
      ).root_id
      recordSandboxDirectoryClaim(db(), {
        rootRunId,
        runId: claim.id,
        projectId: runProjectId,
        path: sandboxRunDir,
        claimedAt: nowIso(),
      })
    }
  })
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
          | { mcp?: { probe_tool?: string } }
          | undefined
        const probeTool = projectSettings?.mcp?.probe_tool ?? null
        const wrap = sandboxSelection.profile
          ? (bin: string, args: string[]) => sandboxLaunchArgv(sandboxSelection.profile!, bin, args)
          : undefined
        const probe = await probeMcpServer({
          server: mcpServerName,
          config: probeConfig,
          cwd,
          env: mcpEnvironment,
          probeTool,
          wrap,
        })
        // The probe runs only when the required server is in .mcp.json, so the
        // wrong-project question is already answered; the doctor path asks it.
        const probeRuling = mcpAttachment.decideMcpToolProbe(
          probe,
          mcpServerName,
          mcpMode,
          name,
          projectAt(callerCwd)?.name ?? null,
        )
        db()
          .query('UPDATE run SET mcp_probe=?, mcp_connected=?, mcp_error=? WHERE id=?')
          .run(
            storedMcpProbe(probe),
            probeRuling.callEvidence.connected,
            probeRuling.callEvidence.error,
            claim.id,
          )
        if (probeRuling.refusalReason) {
          const why = probeRuling.refusalReason
          db()
            .query(
              `UPDATE run SET status='failed', error=?, failure_kind='mcp_unverified', latency_ms=? WHERE id=?`,
            )
            .run(why, Date.now() - started, claim.id)
          await resetSandbox()
          teardownTerminalRunResources(db(), claim.id)
          throw Object.assign(new Error(`run ${claim.id} could not start: ${why}`), {
            runId: claim.id,
          })
        }
        if (probeRuling.failedConnection) {
          mcpConnection = probeRuling.failedConnection
          db()
            .query(`UPDATE run SET mcp_connected=0, mcp_error=? WHERE id=?`)
            .run(mcpConnection.error, claim.id)
          usingMcp = false
        }
      } catch (error) {
        if ((error as { runId?: number }).runId === claim.id) throw error
        const why = String((error as Error)?.message ?? error)
        db()
          .query(
            `UPDATE run SET status='failed', error=?, failure_kind='harness', latency_ms=? WHERE id=?`,
          )
          .run(why, Date.now() - started, claim.id)
        await resetSandbox()
        teardownTerminalRunResources(db(), claim.id)
        throw Object.assign(new Error(`run ${claim.id} could not start: ${why}`), {
          runId: claim.id,
        })
      }
    } else {
      const namesSeen = namesSeenAt(cwd)
      const mismatch = mcpAttachment.decideMcpMirrorMismatch(mcpServerName, namesSeen, mcpMode)
      if (mismatch) {
        mcpConnection = mismatch.connection
        db()
          .query('UPDATE run SET mcp_connected=0, mcp_error=?, mcp_probe=? WHERE id=?')
          .run(mismatch.connection.error, storedMcpProbe(mismatch.recorded), claim.id)
        if (mismatch.refusalReason) {
          const why = mismatch.refusalReason
          db()
            .query(
              `UPDATE run SET status='failed', error=?, failure_kind='harness', latency_ms=? WHERE id=?`,
            )
            .run(why, Date.now() - started, claim.id)
          teardownTerminalRunResources(db(), claim.id)
          throw Object.assign(new Error(`run ${claim.id} could not start: ${why}`), {
            runId: claim.id,
          })
        }
        mcpConnection = mismatch.continuedConnection
        usingMcp = false
        db().query('UPDATE run SET mcp_error=? WHERE id=?').run(mcpConnection.error, claim.id)
      }
    }
  }

  if (requiresCanonSource) {
    prompt += `\n\n${canonSourceInstruction(canonSourceFor(true, mcpConnection, repoJob))}`
    writeFileSync(promptPath.replace(/\.prompt\.txt$/, '.bound.txt'), prompt)
    db()
      .query('UPDATE run SET prompt_sha=?, prompt_bytes=? WHERE id=?')
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
  let idleUnkillable = false
  let idleTreePids: number[] = []
  let idleTreePgid: number | null = null
  let exitCode = -1
  let output = ''
  let vendorTokens: number | null = null
  let costUsd: number | null = null
  let resolvedSession: string | null = vendorSession
  let effectiveModel: string | null = null
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
  let frozenBefore: import('../confinement/confinement.ts').FrozenCheckout[] = []
  let askLoopback: AskLoopback | null = null
  let runLease: ReturnType<typeof acquireRunLease> | null = null
  // Start after orch's own worktree and hook setup, immediately before the
  // vendor process. The interval establishes when a change happened, not who
  // wrote it: an architect or concurrent landing can change a watched checkout.
  const callerProject = projectAt(callerCwd)
  const callerCheckout = callerProject
    ? (gitContext(callerCwd, 'rev-parse', '--show-toplevel') ?? callerCwd)
    : null
  const callerWatch =
    callerCheckout && callerCheckout !== isolatedCwd
      ? [{ project: callerProject!.name, path: callerCheckout }]
      : []
  const candidates = checkoutWatchSet(
    callerWatch,
    worktree?.path,
    opts.repo ?? callerProject?.name ?? null,
  )
  const beforeFreeze = freezeCheckouts(candidates.watched)
  const skipped = [...candidates.failures, ...beforeFreeze.failures]
  // A detached child's stderr reaches nobody, so the skip also rides the output
  // header that `orch result` prints (lens run 2290): the register is stale and
  // the project unwatched on every later run until somebody reads this.
  const skipLines = skipped.map(
    (failure) =>
      `confinement watch skipped ${failure.project} at ${failure.path}: ${failure.error}; ` +
      'fix the register with orch project set',
  )
  for (const line of skipLines) console.error(line)
  if (skipLines.length) {
    mcpSetupHeader = mcpSetupHeader
      ? `${mcpSetupHeader}\n${skipLines.join('\n')}`
      : skipLines.join('\n')
  }
  frozenBefore = beforeFreeze.snapshots
  const watchedCheckouts = frozenBefore.map(({ project, path, expectedHead }) => ({
    project,
    path,
    expectedHead: expectedHead ?? undefined,
  }))

  try {
    runLease = requiredRunLease(claim.id, (cause) => {
      error = String((cause as Error).message ?? cause)
      failureKind = 'harness'
    })
    ;({
      proc,
      timer,
      checkpointTimer,
      idleTimer,
      idleUnkillable,
      idleTreePids,
      idleTreePgid,
      exitCode,
      output,
      vendorTokens,
      costUsd,
      resolvedSession,
      effectiveModel,
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
    } = await runLive({
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
      grokMcpEnvironment,
      recipeEnvironment,
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
    }))
  } finally {
    try {
      ;({
        status,
        error,
        failureKind,
        changes,
        output,
        acceptedQuestions,
        confinementEvent,
        preConfinement,
        artifactsPersisted,
      } = await finishRun({
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
      }))
    } finally {
      runLease?.release()
    }
  }

  return closeRun({
    failureKind,
    name,
    opts,
    claim,
    idleUnkillable,
    status,
    worktree,
    writesJob,
    changes,
    artifactsPersisted,
    idleTreePids,
    idleTreePgid,
    requestedJob,
    callerCwd,
    repoJob,
    declaredDeliverables,
    timeoutMinutes,
    keepTree,
    reason,
    output,
    started,
    exitCode,
    vendorTokens,
    costUsd,
    outPath,
    contract,
    error,
    run,
  })
}
