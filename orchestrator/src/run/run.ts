import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { basename } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { requireAgent } from '../agent/agent-registry.ts'
import { minimumCliVersionRefusal } from '../agent/agents.ts'
import { effectiveEndpointApiKeyForRun } from '../agent/endpoint-api-key.ts'
import { ensureLocalHealth, tryWake } from '../agent/model-host.ts'
import { applyOpenRouterBudgetToAuthFailure } from '../agent/openrouter-auth-failure.ts'
import { checkOpenRouterKeyBudget } from '../agent/openrouter-key-budget.ts'
import { workerHarnessName } from '../agent/worker-launch-env.ts'
import type { AskLoopback } from '../ask/ask.ts'
import { compilePack, type Pack, recordPack } from '../canon/canon.ts'
import type { ConfinementEvent, FreezeFailure } from '../confinement/confinement.ts'
import {
  NO_REPO_PREAMBLE,
  READONLY_PREAMBLE,
  type realQuestions,
  resolveReplyDialect,
  type WorkerReply,
  workerPreamble,
} from '../contract/contract.ts'
import { db, nowIso, sessionId, writableDb, writeTransaction } from '../database/db.ts'
import {
  assertMigrationDispatchAllowed,
  assertMigrationDispatchAllowedAndRecord,
  recordMigrationDispatchRefusal,
} from '../database/migration-drain.ts'
import { preflight } from '../dispatch/dispatch-preflight.ts'
import type { StreamEvent } from '../events.ts'
import { type classify, notify } from '../failure/failure.ts'
import { job, jobBoundInstruction } from '../jobs/jobs.ts'
import {
  canonSourceFor,
  canonSourceInstruction,
  effectiveMcpRequest,
  type McpRequest,
  requiredMcpServer,
  storedMcpRequest,
} from '../mcp/mcp-preflight.ts'
import { namesSeenAt, probeMcpServer, storedMcpProbe } from '../mcp/mcp-probe.ts'
import type { OutcomeStatus } from '../outcome.ts'
import type { RunResourceObserver } from '../process-resource-sampler.ts'
import { projectAt, projectByName, stackAt } from '../project/projects.ts'
import { startedByUserIdForRun } from '../record/record-attribution.ts'
import { recordSandboxDirectoryClaim } from '../resources/resource-claims.ts'
import { teardownTerminalRunResources } from '../resources/resource-ownership.ts'
import {
  CALIBRATION_SUFFIX_RESERVE_BYTES,
  calibrationLine,
  reviewCalibration,
} from '../review/review-calibration.ts'
import type { ReviewRole } from '../review/review-role.ts'
import {
  attributedLaunchKey,
  implicitReviewClaim,
  resolveReviewTarget,
} from '../review/review-target.ts'
import type { ResolvedTaskBranch } from '../route/failover.ts'
import { pick } from '../route/route.ts'
import { runningRunCountForHarness } from '../route/running-runs.ts'
import { type CodexMcpCatalogue, codexMcpSetupHeader } from '../sandbox/codex-mcp-scope.ts'
import { decideCodexSandbox } from '../sandbox/codex-sandbox.ts'
import { mergeMcpSetupHeader } from '../sandbox/project-mcp-scope.ts'
import {
  isWritingAcpRun,
  removeNewSandboxHomeAfterFailure,
  resetSandbox,
  sandboxLaunchArgv,
  sandboxReasonPrefix,
  selectReadonlySandbox,
} from '../sandbox/sandbox.ts'
import {
  assertAcpReady,
  EMPTY_VENDOR_USAGE,
  selectAgentForTransport,
  type TransportName,
} from '../transport/transport.ts'
import type { KeepTreeExemption } from '../worktree/keep-tree-hold.ts'
import { resolveNewTreeBase } from '../worktree/trunk-base-choice.ts'
import { toolFor } from '../worktree/worktree-preflight.ts'
import { assertAcpPolicyAllowed } from './run-acp-policy.ts'
import * as acpWriter from './run-acp-writer.ts'
import { capacityStartupFailure, selectAgentWithCapacityEvents } from './run-agent-capacity.ts'
import { pruneRuns, RUNS_DIR, readDispatchState, runFilePaths } from './run-artifacts.ts'
import { resolveRunBase, shouldResolveRunBase } from './run-base-resolution.ts'
import { prepareRunBoard as board, persistBoundPrompt } from './run-board-prompt.ts'
import { claimRun } from './run-claim.ts'
import { closeRun } from './run-close.ts'
import * as runConfinement from './run-confinement.ts'
import { runEvidence } from './run-evidence-context.ts'
import { assertConfiguredGitGuard, workerGitConfigEnvironment } from './run-git-guard.ts'
import { decideRunLaunch, resolveRunTransport, runTransportPin } from './run-launch.ts'
import { type acquireRunLease, requiredRunLease, withRunCloseOutLease } from './run-lease.ts'
import { runLive } from './run-live.ts'
import * as mcpAttachment from './run-mcp-attachment.ts'
import { finalWorkerMcpRuling } from './run-mcp-attachment-record.ts'
import { enforceRunMcpGrammar } from './run-mcp-grammar.ts'
import {
  projectSelectionForLaunch,
  withheldScopeLine,
  workerMcpLaunchScope,
} from './run-mcp-launch-scope.ts'

import { prepareRunMcpPreflight, selectAgentAndPreflightMcp } from './run-mcp-main-stack.ts'
import {
  bindReviewInstructions,
  checksReviewedCommit,
  initialDispatchPrompt,
  operatorKnowledgeSection,
} from './run-pack-prompt.ts'
import { carriedRefusalFailure, refuseUnstartedRun } from './run-prelaunch-refusal.ts'
import { bindSignals, sha } from './run-process.ts'
import { readOnlyBaseProjectPath, repoOf } from './run-project-context.ts'
import { runInfrastructurePrompt } from './run-readonly-infrastructure.ts'
import { resumeFacts } from './run-resume-kind.ts'
import type { RunResumeOptions } from './run-resume-options.ts'
import { packedResumePrompt } from './run-resume-prompt.ts'
import { rootRunRecordId } from './run-root-record.ts'
import { routedPromptBytes, routedPromptText } from './run-routing-input.ts'
import * as runMigration from './run-schema-reload-cause.ts'
import {
  enforceRunStartupRefusal,
  recordNeverStartedRunFailure,
  recordRunStartupFailure,
} from './run-startup-failure.ts'
import { admitNewRunReference } from './run-task-reference.ts'
import { finishRun, type TerminalInput } from './run-terminal.ts'
import { resolveRunBound } from './run-timeout.ts'
import type { RunResult } from './run-types.ts'
import * as workerHome from './run-worker-home.ts'
import {
  recordSharedGitConfigSnapshotFailure,
  snapshotWritingRunSharedGitConfig,
} from './shared-git-config.ts'
import { renderTaskRulings } from './task-rulings.ts'
import { taskRulingsForDispatch } from './task-rulings-store.ts'

function completeStartup(): true {
  bindSignals()
  return true
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: the lifecycle coordinator keeps one terminal ownership boundary
export async function run(opts: {
  job: string
  prompt: string
  agent?: string
  /** True only when the caller selected the agent rather than routing it. */
  agentExplicit?: boolean
  routedAgent?: { agent: string; reason: string }
  /** Agent whose detached foreground selection completed MCP startup checks. */
  dispatchMcpPreflightedAgent?: string
  schemaPath?: string
  mcp?: McpRequest
  /** A calibration probe: recorded and scorable, but never routing evidence. */
  probe?: boolean
  /** A caller-supplied name for distinguishing sibling runs in a fan-out. */
  label?: string
  /** Stable identity used to calibrate findings-producing review jobs. */
  lens?: string
  reviewRole?: ReviewRole
  model?: string
  /** Pilot opt-in. Default `cli`. */
  transport?: TransportName
  cwd?: string
  /** Internal override for callers whose execution cwd is not their canon source. */
  canonPack?: Pack
  /** Persisted origin: shell cwd in the selected project, else its registered path, else shell cwd. */
  launchCwd?: string
  /** Explicit routing attribution when the caller is outside the registered project. */
  repo?: string
  /** The run this one re-attempts, for `bottega run retry`. */
  retryOf?: string
  noFailover?: boolean
  noWaitCapacity?: boolean
  ownerSession?: string | null
  automaticFailover?: boolean
  /**
   * How much database the worker's worktree gets, where the project asks.
   *
   * The ARCHITECT'S call, not the worker's, and not orchestrator's. It depends on what
   * the task touches — docs need none, a migration needs every table, a report
   * needs the tables it reads — which is a fact about the design rather than
   * about the code, and the worker has not seen the design.
   */
  seed?: string
  /** A ticket key, where the project's branch convention requires one. */
  key?: string
  /** A caller-selected git floor, used only by lifecycle tools that accept it. */
  base?: string
  /** Internal readable base name when a resumed chain resolves from its recorded commit. */
  launchBase?: string
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
   * `bottega run start --detach` needs to print a run id BEFORE the work starts, which it
   * cannot do if the id is allocated in here after routing. So the caller
   * claims a placeholder row, hands the id over, and this fills it in once the
   * agent is picked.
   */
  reserveId?: string
  /**
   * Continue a worker that stopped to ask, instead of starting a new one.
   * Threaded through `run()` rather than given its own function because
   * everything after the command line is identical — the same spawn, the same
   * timeout, the same reaping, the same `finally` that must write a terminal
   * row whatever happened. A second copy of that machinery would be a second
   * place for the bug this system has already had twice: a run that never says
   * it stopped.
   * What a resume changes is only the front: no routing (the conversation
   * belongs to the agent that started it), no new worktree (the worker is
   * mid-edit in one), and `resumeArgv` in place of `argv`.
   */
  resume?: RunResumeOptions
  /** Declared reader deliverable names, from repeated `--deliverable`. */
  deliverables?: string[]
  /** `bottega run start --timeout` in minutes. */
  timeoutMinutes?: number
  /** Opt out of reclaim-at-terminalisation for lens and reader jobs. */
  keepTree?: KeepTreeExemption
  /** Immutable explicit-review target inherited only by automatic failover. */
  resolvedReviewTarget?: { branch: string; commit: string; base: string }
}): Promise<RunResult> {
  writableDb()
  assertMigrationDispatchAllowedAndRecord(db(), opts.resume !== undefined)
  runMigration.enableRunSchemaReload(opts.reserveId)
  const startedByUserId = await startedByUserIdForRun(opts.reserveId !== undefined)
  const requestedJob = job(opts.job),
    mcpRequest = effectiveMcpRequest(opts.mcp, requestedJob)
  const prior = opts.resume
  const resume = resumeFacts(prior?.kind ?? null, opts.reserveId ?? '', prior?.parent ?? null)
  const inheritedDispatch =
    resume.workspaceSource === 'retained' ? readDispatchState(prior!.parent) : null
  const declaredDeliverables = opts.deliverables ?? inheritedDispatch?.deliverables ?? []
  const timeoutMinutes = opts.timeoutMinutes ?? inheritedDispatch?.timeoutMinutes ?? undefined
  const [writesJob, repoJob] = [!!requestedJob.needs.writesRepo, !!requestedJob.needs.readsRepo]
  const forbidsRepo = requestedJob.needs.readsRepo === false
  const requestedTransport = resolveRunTransport(opts)
  const callerCwd = opts.cwd ?? process.cwd(),
    runProjectName = opts.repo ?? repoOf(callerCwd)
  const seed = preflight(
    opts.job,
    callerCwd,
    opts.seed,
    opts.key,
    opts.base,
    !resume.isFirstTurn,
    opts.reserveId !== undefined,
    opts.lens,
    opts.resolvedReviewTarget ? undefined : opts.review,
    opts.carry,
    runProjectName ?? undefined,
    opts.resolvedReviewTarget !== undefined,
  )
  const reviewTarget =
    opts.resolvedReviewTarget ??
    resolveReviewTarget(opts.job, opts.cwd ?? process.cwd(), opts.review, opts.carry)
  const implicitReview = implicitReviewClaim(callerCwd, !!reviewTarget, !!requestedJob.findings)
  const coverageBase = reviewTarget?.base ?? implicitReview.coverageBase
  // Programmatic callers also refuse a bad ref before a run row or worktree exists.
  if (opts.base) {
    const internalRepositoryFailover = opts.automaticFailover && requestedJob.needs.readsRepo
    if (opts.job !== 'implement' && opts.job !== 'fix' && !internalRepositoryFailover) {
      throw new Error('--base is only valid for the implement and fix jobs')
    }
  }
  const readOnlyBase =
    repoJob && !writesJob && !opts.resume?.worktree
      ? resolveNewTreeBase({
          cwd: callerCwd,
          ref: opts.resume?.readOnlyBase ?? reviewTarget?.commit ?? opts.base ?? null,
          carry: Boolean(opts.carry),
          automaticFailover: opts.automaticFailover,
          registeredProjectPath: readOnlyBaseProjectPath(runProjectName ?? undefined, callerCwd),
        })
      : null
  if (shouldResolveRunBase(opts.base, readOnlyBase))
    resolveRunBase({
      cwd: callerCwd,
      base: opts.base,
      resumeParent: opts.resume?.parent,
      launchBase: opts.launchBase,
    })
  // Reachability is routing input, not a run outcome. Configuration stays true while a model host
  // is off, causing jobs and failures to be misrouted; this cheap probe replaces a doomed run.
  //
  // Awaited before pick() and cached so a fan-out probes once rather than per run.
  const health = await ensureLocalHealth()
  // Down, so ask it to come back — and then carry on without it.
  //
  // A cold start is 5m42s measured (power-on to `Application startup complete`),
  // which no caller can wait for, so this is fire-and-continue: the packet goes
  // out, THIS job routes to a cloud agent as it would have anyway, and the next
  // one minutes later finds the endpoint up. Nothing is slower than it was; the
  // difference is that the outage now ends by itself.
  //
  // Opt-in via BOTTEGA_MODEL_HOST_WOL_MAC, because the box is shared and powering on
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
   * The caller's prompt is stored unwrapped at prompt_path so `bottega run retry` can
   * re-send it and wrap once. The bound text — preamble plus prompt — is what
   * the agent is actually sent, hashed and routed, and is written beside it as
   * `bound-prompt.txt`. Wrapping it further down would send a payload the database
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
   * The worker is TOLD about the infrastructure it has, in the project's own words.
   *
   * A worker that does not know it can serve its branch on its own port verifies against another branch's bundle
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
    tool: toolFor(callerCwd),
    callerCwd,
    readsRepo: repoJob,
    writesRepo: writesJob,
    readOnlyBase,
  })
  const [originalPrompt, resolvedDialect] = [opts.prompt, resolveReplyDialect(requestedJob)]
  const replySchemaName = opts.schemaPath ? basename(opts.schemaPath) : resolvedDialect.schemaName
  const runProjectId = runProjectName ? (projectByName(runProjectName)?.recordId ?? null) : null
  let pack: ReturnType<typeof compilePack> | null = null
  if (resume.isFirstTurn) {
    try {
      pack = opts.canonPack ?? compilePack({ job: opts.job, cwd: callerCwd })
      recordPack(pack)
    } catch (cause) {
      const message = (cause as Error).message
      let failedId = opts.reserveId
      if (failedId) recordRunStartupFailure(failedId, cause)
      else {
        failedId = newRecordId()
        const links = await admitNewRunReference({
          projectName: runProjectName,
          projectRecordId: runProjectId,
          key: opts.key ?? null,
          cwd: callerCwd,
          launchCwd: callerCwd,
          probe: Boolean(opts.probe),
        })
        recordNeverStartedRunFailure({
          recordId: failedId,
          error: cause,
          job: opts.job,
          repo: runProjectName,
          projectRecordId: links.projectRecordId,
          taskRecordId: links.taskRecordId,
          probe: Boolean(opts.probe),
          cwd: callerCwd,
          promptSha: sha(originalPrompt),
          specSha: sha(originalPrompt),
          promptBytes: Buffer.byteLength(originalPrompt),
          promptHead: originalPrompt.slice(0, 200).replace(/\s+/g, ' '),
          sessionId: opts.ownerSession ?? sessionId(),
          mcp: storedMcpRequest(mcpRequest),
          startedByUserId,
          agentExplicit: Number(Boolean(opts.agentExplicit)),
        })
      }
      throw Object.assign(new Error(`run ${failedId} could not start: ${message}`), {
        runId: failedId,
      })
    }
  }
  const docsSection = operatorKnowledgeSection(pack ?? null)
  const dispatchKey = attributedLaunchKey({
    writesJob,
    key: opts.key,
    cwd: callerCwd,
  })
  const carriedRulings = taskRulingsForDispatch({
    resume: !resume.isFirstTurn,
    project: runProjectName,
    launchKey: dispatchKey,
  })
  const rulingsSection = renderTaskRulings(carriedRulings)
  let prompt =
    opts.resume?.kind === 'continue'
      ? packedResumePrompt(opts.job, originalPrompt, opts.resume.parent)
      : initialDispatchPrompt({
          writesJob,
          preamble: writesJob
            ? workerPreamble(opts.job)
            : repoJob
              ? READONLY_PREAMBLE
              : NO_REPO_PREAMBLE,
          infrastructure: infra,
          operatorKnowledge: docsSection,
          taskRulings: rulingsSection,
          spec: originalPrompt,
        })
  prompt = bindReviewInstructions({
    prompt,
    findings: Boolean(requestedJob.findings),
    firstTurn: resume.isFirstTurn,
    reviewTarget,
    readsRepo: repoJob,
    checkoutCommit: readOnlyBase,
    coverageBase: implicitReview.coverageBase,
    lens: opts.lens,
    repo: runProjectName,
  })
  const evidencePrompt = runEvidence(opts.job, Boolean(requestedJob.findings), declaredDeliverables)
  prompt = routedPromptText(prompt, evidencePrompt.readerInstruction, resume.isFirstTurn)
  const requiresCanonSource = evidencePrompt.requiresCanonSource
  /**
   * The bytes this run's pick ranks on, kept for the failover pick below.
   *
   * A failover re-dispatches the same prompt through another agent, so it must
   * route on the size the original pick measured rather than on a size taken
   * from the raw spec it re-reads. Computed here, before the bound line is
   * appended, because that is the prompt the pick was given.
   */
  const pickPromptBytes = routedPromptBytes(
    prompt,
    replySchemaName,
    requestedJob,
    requiresCanonSource,
  )
  const transportPin = runTransportPin(opts.transport, process.env.BOTTEGA_TRANSPORT),
    transportPinFacts = {
      explicitTransport: transportPin.transportPinSource === 'explicit',
      envTransport: transportPin.transportPinSource === 'environment',
    },
    requiredMcp = requiredMcpServer(mcpRequest, callerCwd, runProjectName ?? undefined)
  const pickSource = () =>
    pick(
      opts.job,
      selectAgentForTransport(requestedTransport, opts.agent),
      pickPromptBytes,
      true,
      stackAt(callerCwd),
      {
        agents: opts.avoid,
        models: opts.distinctModels,
        model: opts.model,
        noWaitCapacity: opts.noWaitCapacity,
        requiredMcp,
        ...transportPin,
        project: runProjectName,
        routed: opts.routedAgent,
      },
      opts.probe,
      opts.lens,
    )
  const selectFirstTurnAgent = () =>
    selectAgentAndPreflightMcp({
      select: () =>
        selectAgentWithCapacityEvents({
          runId: opts.reserveId,
          select: pickSource,
          noWait: opts.noWaitCapacity,
        }),
      mcpRequest,
      cwd: callerCwd,
      job: opts.job,
      projectName: runProjectName ?? undefined,
      preflightedAgent: opts.dispatchMcpPreflightedAgent,
      onFailure: (cause) =>
        recordRunStartupFailure(opts.reserveId, ...capacityStartupFailure(cause, opts.reserveId)),
    })
  const source = resume.isFirstTurn
    ? {
        source: 'pick' as const,
        ...(await selectFirstTurnAgent()),
      }
    : // A resume keeps its already-selected worker and does not make a new delegation decision.
      { source: 'resume' as const, ...opts.resume! }
  const launch = decideRunLaunch({ ...source, ...transportPinFacts })
  const a = requireAgent(launch.agent)
  const transportName = launch.useRequestedTransport ? requestedTransport : a.defaultTransport
  const writingAcp = isWritingAcpRun(transportName, writesJob)
  const { agent: name, reason } = launch
  const codexSandbox = decideCodexSandbox()
  const boundMs = resolveRunBound(requestedJob, a, timeoutMinutes, opts.reserveId)
  if (resume.isFirstTurn) {
    const boundLine = `\n\n${jobBoundInstruction(requestedJob, boundMs)}`
    const split = prompt.lastIndexOf('\n---\n')
    prompt =
      split >= 0 ? prompt.slice(0, split) + boundLine + prompt.slice(split) : prompt + boundLine
  }
  if (transportName === 'acp') {
    try {
      assertAcpPolicyAllowed(opts.job, a.name, a, opts.agentExplicit, resume.isFirstTurn)
      assertAcpReady(name, a)
    } catch (e) {
      recordRunStartupFailure(opts.reserveId, e)
      throw e
    }
  }
  prompt = acpWriter.bindContract(prompt, writingAcp)
  if (name === 'codex') enforceRunStartupRefusal(opts.reserveId, minimumCliVersionRefusal(a))
  const { decideMcpLaunchRuling } = mcpAttachment
  const mcpLaunchRuling = decideMcpLaunchRuling(mcpRequest, requiredMcp, a, transportPin)
  enforceRunStartupRefusal(opts.reserveId, mcpLaunchRuling.refusalReason)
  // Append after routing, before prompt files, hashes, or metadata.
  if (requestedJob.findings && resume.isFirstTurn) {
    const suffix = calibrationLine(reviewCalibration(opts.lens!, name, opts.model ?? a.model))
    if (Buffer.byteLength(suffix) > CALIBRATION_SUFFIX_RESERVE_BYTES) {
      throw new Error('review calibration line exceeded its reserved routing allowance')
    }
    prompt += `\n\n${suffix}`
  }
  let { deferredCwdMcpPlan, mcpConnection } = prepareRunMcpPreflight({
    mcpRequest,
    callerCwd,
    projectName: runProjectName ?? undefined,
    forbidsRepo,
    repoJob,
    discoversMcpFromCwd: a.caps.discoversMcpFromCwd,
    agent: name,
  })
  const attachmentRuling = mcpAttachment.decideMcpAttachment({
    connection: mcpConnection,
    mcpRequest,
    writesJob,
    agentHasMcp: mcpLaunchRuling.agentHasMcp,
  })
  enforceRunStartupRefusal(opts.reserveId, attachmentRuling.refusalReason)
  let { mcpMode, usingMcp } = attachmentRuling
  // Every repository job gets writable scratch; only `writesJob` requests a diff.
  // Minted before the spawn when the agent lets us choose, so the resume handle
  // exists even for a worker that dies mid-turn. codex and qwen name their own
  // and are read back afterwards instead.
  const vendorSession: string | null =
    opts.resume?.kind === 'continue' ? (opts.resume.session ?? null) : (a.mintSession?.() ?? null)
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
  let outPath = paths.output
  let {
    promptPath,
    outputPath: claimedOutputPath,
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
    runtimeDir,
    runtimeDirExisted,
    cwd,
    prompt: claimedBoundPrompt,
    mcpConnection: claimedMcpConnection,
    usingMcp: claimedUsingMcp,
  } = await claimRun({
    opts,
    runsDir: RUNS_DIR,
    stamp,
    name,
    generatedSchema: resolvedDialect.schema,
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
    timeoutMs: boundMs,
    forbidsRepo,
    reviewTarget,
    implicitReview,
    coverageBase,
    readOnlyBase,
    deferredCwdMcpPlan,
    usingMcp,
    startedByUserId,
    replySchemaName,
    carriedQuestionIds: carriedRulings.rulings.map((ruling) => ruling.questionRecordId),
    assertDispatchAllowed: () => assertMigrationDispatchAllowed(db(), opts.resume !== undefined),
    recordDispatchRefusal: recordMigrationDispatchRefusal,
  })
  runMigration.enableRunSchemaReload(claim.id)
  outPath = claimedOutputPath
  const initialBoard = await board(claimedBoundPrompt, promptPath, claim.id, resume.isFirstTurn)
  prompt = initialBoard.prompt
  ;[mcpConnection, usingMcp] = [claimedMcpConnection, claimedUsingMcp]
  const runProject = projectAt(callerCwd)
  const endpoint = effectiveEndpointApiKeyForRun(a, runProject)
  const writableRoots = acpWriter.runRoots(worktree, writesJob, writingAcp, scratchDir, runtimeDir)
  const checkpointContainment = acpWriter.prepareCheckpoint(worktree, writingAcp, runtimeDir)
  const brokerNeedsNetwork = Boolean(runProject?.settings.mainStack?.consumers?.includes('gate'))
  const gitConfigEnvironment = workerGitConfigEnvironment(worktree, writesJob, requestedJob.name)
  const recipeEnvironment = {
    ...workerHome.trackedWorkerEnvironment(repoJob, writesJob, worktree, claim.id),
    ...workerHome.codexPrivateTempEnvironment(workerHarnessName(a), repoJob, scratchDir),
  }
  assertConfiguredGitGuard(gitConfigEnvironment, writableRoots)
  let askLoopback: AskLoopback | null = null
  const mcpLaunch = workerMcpLaunchScope({
    agent: a,
    transport: transportName,
    usingMcp,
    writesJob,
    callerCwd,
    cwd,
    connection: mcpConnection,
  })
  const mcpServerName = mcpLaunch.serverName
  let sandboxSelection: ReturnType<typeof selectReadonlySandbox>
  let sandboxEnvironment: Record<string, string>
  let mcpEnvironment: Record<string, string>
  let codexMcpCatalogues: CodexMcpCatalogue[]
  let hasRunScopedHome: boolean,
    startupComplete = false
  try {
    try {
      const writingAcpAsk = acpWriter.prepareWritingAcpAsk(writingAcp, claim.id, runToken)
      askLoopback = writingAcpAsk.loopback
      sandboxSelection = selectReadonlySandbox({
        agent: name,
        readsRepo: repoJob,
        writesRepo: writesJob,
        worktree: worktree?.path ?? isolatedCwd,
        runtimeDir,
        scratchDir,
        project: runProject,
        override: process.env.BOTTEGA_SANDBOX,
        path: process.env.PATH,
        baseUrl: a.baseUrl,
        mcp: Boolean(mcpMode),
        mcpAllowlist: mcpMode ? mcpLaunch.allowlist : [],
        writingAcp,
        ...writingAcpAsk.sandbox,
      })
      const home = await workerHome.prepareWorkerHomeLaunch({
        agent: a,
        sandbox: sandboxSelection.sandbox,
        runDir: runtimeDir,
        runNumber: claim.number,
        runRecordId: claim.recordId,
        runToken,
        environment: {
          ...(gitConfigEnvironment ?? {}),
          ...(await endpoint.resolve()),
        },
        grokEnvironment: grokMcpEnvironment,
        includeStore: repoJob,
        mcpLaunch,
        mcpMode,
        project: runProject,
      })
      ;({
        codexMcpCatalogues,
        environment: mcpEnvironment,
        hasRunScopedHome,
        sandboxEnvironment,
      } = home)
    } catch (e) {
      removeNewSandboxHomeAfterFailure(runtimeDir, runtimeDirExisted)
      const why = String((e as Error)?.message ?? e)
      try {
        // A pre-launch refusal carries its own failure kind: the agent never
        // ran, so routing and failover must not read this as 'harness'.
        recordRunStartupFailure(claim.id, e, started, carriedRefusalFailure(e))
      } finally {
        teardownTerminalRunResources(db(), claim.id)
      }
      throw Object.assign(new Error(`run ${claim.id} could not start: ${why}`), { runId: claim.id })
    }
    mcpSetupHeader = codexMcpSetupHeader(mcpSetupHeader, mcpLaunch.codex, codexMcpCatalogues)
    mcpSetupHeader = mergeMcpSetupHeader(
      mcpSetupHeader,
      withheldScopeLine(transportName, workerHarnessName(a), mcpLaunch.projectSelection),
    )
    const sandboxRouteReason = sandboxSelection.reason
      ? `${reason}; ${sandboxReasonPrefix(sandboxSelection.sandbox)}: ${sandboxSelection.reason}`
      : reason
    writeTransaction(() => {
      db()
        .query('UPDATE run SET sandbox=?, route_reason=? WHERE record_id=?')
        .run(sandboxSelection.sandbox, sandboxRouteReason, claim.id)
      if (hasRunScopedHome) {
        const rootRunId = rootRunRecordId(claim.id)
        recordSandboxDirectoryClaim(db(), {
          rootRunId,
          runId: claim.id,
          projectId: runProjectId,
          path: runtimeDir,
          claimedAt: nowIso(),
        })
      }
    })
    if (sandboxSelection.reason) {
      const header = `${sandboxReasonPrefix(sandboxSelection.sandbox)}: ${sandboxSelection.reason}`
      mcpSetupHeader = mcpSetupHeader ? `${mcpSetupHeader}\n${header}` : header
      console.error(`orch: run ${claim.id} ${header}`)
    }
    if (mcpMode && mcpServerName) {
      const probeConfig = mcpLaunch.config[mcpServerName]
      if (probeConfig?.url || probeConfig?.command) {
        try {
          const projectSettings = projectAt(callerCwd)?.settings as
            | { mcp?: { probe_tool?: string } }
            | undefined
          const probeTool = projectSettings?.mcp?.probe_tool ?? null
          const wrap = sandboxSelection.profile
            ? (bin: string, args: string[]) =>
                sandboxLaunchArgv(sandboxSelection.profile!, bin, args)
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
            .query('UPDATE run SET mcp_probe=?, mcp_connected=?, mcp_error=? WHERE record_id=?')
            .run(
              storedMcpProbe(probe),
              probeRuling.callEvidence.connected,
              probeRuling.callEvidence.error,
              claim.id,
            )
          const grammarFailure = await enforceRunMcpGrammar({
            server: mcpServerName,
            mode: mcpMode,
            probe,
            pattern: a.mcpToolNamePattern,
            runId: claim.id,
            started,
            resetSandbox,
          })
          probeRuling.failedConnection = grammarFailure ?? probeRuling.failedConnection
          if (probeRuling.refusalReason) {
            await refuseUnstartedRun({
              runId: claim.id,
              started,
              why: probeRuling.refusalReason,
              resetSandbox,
            })
          }
          if (probeRuling.failedConnection) {
            mcpConnection = probeRuling.failedConnection
            db()
              .query(`UPDATE run SET mcp_connected=0, mcp_error=? WHERE record_id=?`)
              .run(mcpConnection.error, claim.id)
            usingMcp = false
          }
        } catch (error) {
          if ((error as { runId?: string }).runId === claim.id) throw error
          const why = String((error as Error)?.message ?? error)
          try {
            recordRunStartupFailure(claim.id, error, started)
          } finally {
            try {
              await resetSandbox()
            } finally {
              teardownTerminalRunResources(db(), claim.id)
            }
          }
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
            .query('UPDATE run SET mcp_connected=0, mcp_error=?, mcp_probe=? WHERE record_id=?')
            .run(mismatch.connection.error, storedMcpProbe(mismatch.recorded), claim.id)
          if (mismatch.refusalReason) {
            const why = mismatch.refusalReason
            try {
              recordRunStartupFailure(claim.id, why, started)
            } finally {
              teardownTerminalRunResources(db(), claim.id)
            }
            throw Object.assign(new Error(`run ${claim.id} could not start: ${why}`), {
              runId: claim.id,
            })
          }
          mcpConnection = mismatch.continuedConnection
          usingMcp = false
          db()
            .query('UPDATE run SET mcp_error=? WHERE record_id=?')
            .run(mcpConnection.error, claim.id)
        }
      }
    }
    if (requiresCanonSource) {
      prompt += `\n\n${canonSourceInstruction(canonSourceFor(true, mcpConnection, repoJob))}`
      persistBoundPrompt(promptPath, prompt, claim.id)
    }
    startupComplete = completeStartup()
  } finally {
    await acpWriter.disposeAskAfterStartup(askLoopback, startupComplete)
  }
  const sharedGitConfigSnapshot = snapshotWritingRunSharedGitConfig({
    runId: claim.id,
    writesJob,
    worktree: worktree?.path ?? null,
    writableRoots,
  })
  recordSharedGitConfigSnapshotFailure(claim.id, sharedGitConfigSnapshot)
  // Keep this handle visible to signals/finally so a running row can terminate.
  // A full Subprocess would widen the narrowed `p` streams.
  let proc: { pid?: number | null; kill(sig?: number | string): void } | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let checkpointTimer: ReturnType<typeof setInterval> | null = null
  let resourceObserver: RunResourceObserver | null = null
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
  let contract: WorkerReply | null = null
  let contractObjects = 0
  let acceptedQuestions: ReturnType<typeof realQuestions> = []
  let status: OutcomeStatus = 'failed'
  let error: string | null = null
  let failureKind: ReturnType<typeof classify> | null = null
  let billingHoldDetail: string | undefined
  let artifactsPersisted = true,
    workerEvents: StreamEvent[] = []
  let preConfinement: string | null = null
  let vendorTerminatedStream: string | null = null
  const confinementFailures: FreezeFailure[] = []
  let confinementEvent: ConfinementEvent | null = null
  let frozenBefore: import('../confinement/confinement.ts').FrozenCheckout[] = []
  let runLease: ReturnType<typeof acquireRunLease> | null = null
  const { callerCheckout, candidates, beforeFreeze } = runConfinement.freezeBeforeRunCheckouts({
    srtProfile: sandboxSelection.profile,
    agent: name,
    cwd,
    writableRoots,
    tmpDir: process.env.TMPDIR,
    codexSandbox: codexSandbox.sandbox,
    callerCwd,
    isolatedCwd,
    runProject,
    activeWorktree: worktree?.path,
    runProjectName,
  })
  const skipped = [...candidates.failures, ...beforeFreeze.failures]
  const skipLines = runConfinement.confinementSkipLines(skipped)
  for (const line of skipLines) console.error(line)
  if (skipLines.length) {
    mcpSetupHeader = mcpSetupHeader
      ? `${mcpSetupHeader}\n${skipLines.join('\n')}`
      : skipLines.join('\n')
  }
  frozenBefore = beforeFreeze.snapshots
  const watchedCheckouts = frozenBefore
  // The close-out lease covers both terminal recording and closeRun, even when either rejects.
  return await withRunCloseOutLease(
    claim.id,
    (cause) => {
      error = String((cause as Error).message ?? cause)
      failureKind = 'harness'
    },
    // biome-ignore lint/complexity/noExcessiveLinesPerFunction: one close-out lease encloses the lifecycle's terminal ownership boundary
    async () => {
      try {
        runLease = requiredRunLease(claim.id, (cause) => {
          error = String((cause as Error).message ?? cause)
          failureKind = 'harness'
        })
        ;({
          proc,
          timer,
          checkpointTimer,
          resourceObserver,
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
          contract,
          contractObjects,
          acceptedQuestions,
          status,
          error,
          failureKind,
          artifactsPersisted,
          preConfinement,
          vendorTerminatedStream,
          askLoopback,
          mcpSetupHeader,
          workerEvents,
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
          writes: repoJob,
          usingMcp,
          mcpServerName,
          codexMcpScope: mcpLaunch.codex,
          projectMcpSelection: projectSelectionForLaunch(usingMcp, mcpLaunch.projectSelection),
          mcpTrustGranted,
          writableRoots,
          gitConfigEnvironment,
          runtimeDir,
          recipeEnvironment,
          launchEnvironment: mcpEnvironment,
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
          initialBoardNoticeIds: initialBoard.noticeIds,
          throttleConcurrency: () => runningRunCountForHarness('codex'),
          askLoopback,
          ...acpWriter.lifecycleFacts(writingAcp, checkpointContainment, brokerNeedsNetwork),
        }))
        if (failureKind === 'auth') {
          ;({ failureKind, error, billingHoldDetail } = applyOpenRouterBudgetToAuthFailure(
            failureKind,
            error,
            await checkOpenRouterKeyBudget(endpoint.row),
          ))
        }
      } finally {
        const mcpRuling = finalWorkerMcpRuling(claim.id, mcpMode, mcpServerName, workerEvents)
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
            resourceObserver,
            proc,
            askLoopback,
            claim,
            writesJob,
            worktree,
            launchKey,
            failureKind,
            billingHoldDetail,
            endpointKey: endpoint.key,
            scratchDir,
            gitConfigEnvironment,
            ...acpWriter.lifecycleFacts(writingAcp, checkpointContainment, brokerNeedsNetwork),
            opts,
            watchedCheckouts,
            confinementFailures,
            frozenBefore,
            callerRemoval: runConfinement.callerRemovalAtRunEnd(db(), callerCheckout, started),
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
            checkReviewedCommit: checksReviewedCommit(Boolean(requestedJob.findings), repoJob),
            output,
            confinementEvent,
            parsedReply: resolvedDialect.parse(output).reply as TerminalInput['parsedReply'],
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
            vendorUsage,
            effectiveModel,
            resolvedSession,
            name,
            artifactsPersisted,
            mcpRuling,
            workerEvents,
          }))
        } finally {
          runLease?.release()
        }
      }
      return await closeRun({
        failureKind,
        billingHoldDetail,
        endpointKey: endpoint.key,
        name,
        opts,
        pickPromptBytes,
        claim,
        idleUnkillable,
        status,
        worktree,
        writesJob,
        changes,
        artifactsPersisted,
        idleTreePids,
        idleTreePgid,
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
    },
  )
}
