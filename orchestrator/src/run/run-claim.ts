// concern: run-claim
/**
 * Knows run row claiming, repository tree creation under project locks,
 * provisioning, confinement preparation, and failed-claim teardown. Must not
 * know live worker processes, terminal outcomes, transports, or the CLI.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import type { Agent } from '../agent/agents.ts'
import { settleCreateTimeBranchCleanup } from '../branch/create-time-settlement.ts'
import { type TaskBranchCandidate, taskBranchLandingTreeRefusal } from '../branch/task-branch.ts'
import type { Pack } from '../canon/canon.ts'
import { readStrictCodexSchema } from '../contract/codex-schema.ts'
import { replyFileInstruction, TEXT_REPLY_SCHEMA } from '../contract/contract.ts'
import { db, nowIso, sessionId, writeTransaction } from '../database/db.ts'
import { namesRecordedRunTree } from '../dispatch/dispatch-preflight.ts'
import { retargetRepositoryPromptForDispatch } from '../dispatch/prompt-retarget.ts'
import { appendRunEvent } from '../events.ts'
import { checkoutAliases, realpathOrSpelled } from '../git/checkout-identity.ts'
import { branchOf, gitContext, repoRootOf } from '../git/git-environment.ts'
import {
  type DeferredCwdMcpStep,
  type McpConnection,
  type McpMode,
  type McpRequest,
  storedMcpRequest,
} from '../mcp/mcp-preflight.ts'
import { withWorktreeCreateLock, withWorktreeLease } from '../project/project-lock.ts'
import { projectAt, stackAt } from '../project/projects.ts'
import {
  claimRecipePort,
  RECIPE_PORT_BAND,
  recordCreatedWorktreeClaims,
  recordDatabaseClaim,
} from '../resources/resource-claims.ts'
import { teardownTerminalRunResources } from '../resources/resource-ownership.ts'
import type { ReviewRole } from '../review/review-role.ts'
import { attributedLaunchKey } from '../review/review-target.ts'
import { resolveSupersededTurn } from '../route/failover.ts'
import { runOwnedPaths } from '../run-owned-paths.ts'
import { type KeepTreeExemption, keepTreeHold } from '../worktree/keep-tree-hold.ts'
import { writerTreeBaseRef } from '../worktree/trunk-base-choice.ts'
import { createWorkerWorktree, worktreeExists } from '../worktree/worktree.ts'
import {
  assertCallerAncestry,
  type CarriedWorkingState,
  carryWorkingState,
  shouldAssertCallerAncestry,
} from '../worktree/worktree-caller.ts'
import {
  createIsolatedWorkerDirectory,
  type prepareWorkerMcpConfig,
} from '../worktree/worktree-mcp.ts'
import { toolFor } from '../worktree/worktree-preflight.ts'
import { removeFor } from '../worktree/worktree-remove.ts'
import type { Worktree } from '../worktree/worktree-types.ts'
import { assertBranchHasNoAliveOwner } from './branch-owner-guard.ts'
import { closeRunChainQuestions, QUESTION_CLOSE_ATTEMPT_FAILED_OVER } from './question-close.ts'
import { resumeCreationOptions } from './resume-tree.ts'
import {
  noRepoIsolatePath,
  prepareFiles,
  writeDispatchState,
  writeGeneratedSchema,
} from './run-artifacts.ts'
import { inheritedRunFacts } from './run-claim-inheritance.ts'
import { executeClaimedMcpPlan } from './run-claim-mcp.ts'
import {
  claimedRunBranch,
  claimTreePlanForCandidate,
  resumeCreationLifecycle,
  resumeCreationTool,
  retryRootTreeValidation,
  shouldResolveTaskBranch,
  taskBranchKey,
} from './run-claim-plan.ts'
import { claimWithMigrationAdmission } from './run-claim-transaction.ts'
import { nextRunNumber } from './run-number.ts'
import { errorTail, sha } from './run-process.ts'
import { prepareResumeBranchIfNeeded, restoreResumeIfNeeded } from './run-resume-claim.ts'
import { claimIdentity, resumeFacts } from './run-resume-kind.ts'
import type { RunResumeOptions } from './run-resume-options.ts'
import { assertRetryRootWorkspace } from './run-retry-claim.ts'
import { recordRunStartupFailure } from './run-startup-failure.ts'
import { taskBranchResolution } from './run-task-branch-resolution.ts'
import { admitNewRunReference } from './run-task-reference.ts'

type ClaimOptions = {
  reserveId?: string
  agentExplicit?: boolean
  transport?: 'cli' | 'acp'
  schemaPath?: string
  job: string
  label?: string
  probe?: boolean
  retryOf?: string
  ownerSession?: string | null
  automaticFailover?: boolean
  review?: string
  model?: string
  lens?: string
  reviewRole?: ReviewRole
  keepTree?: KeepTreeExemption
  noFailover?: boolean
  key?: string
  cwd?: string
  launchCwd?: string
  base?: string
  launchBase?: string
  resolvedTaskBranch?: TaskBranchCandidate | null
  carry?: boolean
  resume?: RunResumeOptions
}

const explicitRunFlags = (opts: ClaimOptions) =>
  [opts.automaticFailover ? 1 : 0, opts.agentExplicit ? 1 : 0, opts.transport ? 1 : 0] as const

const reviewClaimBindings = (opts: ClaimOptions) =>
  [opts.review ?? null, opts.reviewRole ?? null] as const

export type ClaimInput = {
  opts: ClaimOptions
  runsDir: string
  stamp: string
  name: string
  generatedSchema: unknown
  originalPrompt: string
  prompt: string
  callerCwd: string
  seed: string | undefined
  writesJob: boolean
  repoJob: boolean
  runProjectName: string | null
  runProjectId: string | null
  reason: string
  vendorSession: string | null
  pack: Pack | null
  mcpRequest: McpRequest | undefined
  transportName: 'cli' | 'acp'
  a: Agent
  mcpConnection: McpConnection | null
  mcpMode: McpMode | null
  declaredDeliverables: string[]
  timeoutMinutes: number | undefined
  timeoutMs: number
  forbidsRepo: boolean
  reviewTarget: { branch: string; commit: string; base: string } | null
  implicitReview: { branch: string | null; findings: boolean }
  coverageBase: string | null
  readOnlyBase: string | null
  deferredCwdMcpPlan: DeferredCwdMcpStep[]
  usingMcp: boolean
  startedByUserId: string | null
  replySchemaName: string
  carriedQuestionIds: string[]
  precomputedLinks?: { taskRecordId: string | null; projectRecordId: string | null } | null
  assertDispatchAllowed(): void
  recordDispatchRefusal?(cause: unknown): void
}

import type { ClaimResult } from './run-claim-types.ts'

export type { ClaimResult } from './run-claim-types.ts'

function sandboxRootForRun(runId: string): { record_id: string } {
  return db()
    .query<{ record_id: string }, [string]>(
      `SELECT root.record_id FROM run member
       JOIN run root ON root.record_id=COALESCE(member.parent_run_record_id,member.record_id)
       WHERE member.record_id=?`,
    )
    .get(runId)!
}

function claimRecordId(reserveId: string | undefined): string {
  if (!reserveId) return newRecordId()
  const reservation = db()
    .query<{ record_id: string }, [string]>('SELECT record_id FROM run WHERE record_id=?')
    .get(reserveId)
  if (!reservation) throw new Error(`reserved run ${reserveId} does not exist`)
  return reserveId
}

function claimableRow<T>(
  reserveId: string | undefined,
  updateReserved: () => T | null,
  insertFresh: () => T,
): T {
  const row = reserveId ? updateReserved() : insertFresh()
  if (!row) throw new Error(`reserved run ${reserveId} is no longer claimable`)
  return row
}

async function claimLinks(
  input: ClaimInput,
  launchKey: string | null,
  launchCwd: string,
  inherited: { task_record_id: string | null; project_record_id: string | null } | null,
) {
  if (!inherited && input.precomputedLinks) return input.precomputedLinks
  return admitNewRunReference({
    inheritedTaskRecordId: inherited?.task_record_id,
    inheritedProjectRecordId: inherited?.project_record_id,
    projectName: input.runProjectName,
    projectRecordId: input.runProjectId,
    key: launchKey,
    cwd: input.repoJob ? null : input.callerCwd,
    launchCwd,
    probe: Boolean(input.opts.probe),
  })
}

export async function claimRun(input: ClaimInput): Promise<ClaimResult> {
  let {
    opts,
    runsDir,
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
    timeoutMs,
    forbidsRepo,
    reviewTarget,
    implicitReview,
    coverageBase,
    readOnlyBase,
    deferredCwdMcpPlan,
    usingMcp,
    startedByUserId,
    replySchemaName,
    carriedQuestionIds,
  } = input
  const resume = resumeFacts(
    opts.resume?.kind ?? null,
    opts.reserveId ?? '',
    opts.resume?.parent ?? null,
  )
  const claimedPrompt = opts.reserveId
    ? ((
        db().query('SELECT prompt_path FROM run WHERE record_id=?').get(opts.reserveId) as {
          prompt_path: string | null
        } | null
      )?.prompt_path ?? null)
    : null
  const recordId = claimRecordId(opts.reserveId)
  const { promptPath, outputPath } = prepareFiles(runsDir, recordId, claimedPrompt, originalPrompt)
  // Beside the prompt it wraps; detach() may already have named that prompt path.
  /**
   * The return contract is written to disk: codex's `--output-schema` wants a
   * path and grok's `--json-schema`
   * wants the text, which agents.ts reads back from the same file.
   *
   * A caller's own `--schema` still wins. `bottega run start implement --schema mine.json`
   * is a deliberate act by someone who wants a different contract, and silently
   * overriding it would make the flag a lie.
   */
  const originalSchemaPath = writeGeneratedSchema(runsDir, stamp, generatedSchema, opts.schemaPath)
  const textReplyContract = !opts.schemaPath && generatedSchema === TEXT_REPLY_SCHEMA
  // Normalize Codex's strict schema beside the prompt; leave the caller's file untouched for Grok.
  const schemaPath =
    name === 'codex' && originalSchemaPath
      ? (() => {
          const p = join(runsDir, `${stamp}.codex-schema.json`)
          writeFileSync(p, JSON.stringify(readStrictCodexSchema(originalSchemaPath), null, 2))
          return p
        })()
      : originalSchemaPath
  const started = Date.now()
  const head = originalPrompt.slice(0, 200).replace(/\s+/g, ' ')
  const inheritedLaunch =
    resume.workspaceSource === 'retained' ? inheritedRunFacts(opts.resume!.parent) : null
  const recordedBranch = (worktreeBranch: string | null) =>
    claimedRunBranch(
      reviewTarget?.branch ?? null,
      implicitReview.branch,
      implicitReview.findings ? (inheritedLaunch?.branch ?? null) : null,
      worktreeBranch,
    )
  const launchCwd = inheritedLaunch?.launch_cwd ?? opts.launchCwd ?? callerCwd
  const launchSeed = inheritedLaunch?.launch_seed ?? seed ?? null
  const attributedKey = attributedLaunchKey({ writesJob, key: opts.key, cwd: callerCwd })
  const launchKey = inheritedLaunch?.launch_key ?? attributedKey
  const links = await claimLinks(input, launchKey, launchCwd, inheritedLaunch)
  const taskRecordId = links.taskRecordId
  runProjectId = links.projectRecordId
  const launchBase = inheritedLaunch?.launch_base ?? opts.launchBase ?? opts.base ?? null
  const noFailover = inheritedLaunch ? !!inheritedLaunch.no_failover : !!opts.noFailover
  const worktreeTool = repoJob ? toolFor(callerCwd) : null
  const resumePlan = opts.resume?.treePlan
  let resolvedTaskBranch: TaskBranchCandidate | null = null
  const attachableTaskKey = taskBranchKey(launchKey, Boolean(resumePlan))
  if (
    shouldResolveTaskBranch({
      repoJob,
      writesJob,
      hasWorktree: Boolean(opts.resume?.worktree),
      taskKey: attachableTaskKey,
      isResume: resume.workspaceSource === 'retained',
      hasExplicitBase: opts.base !== undefined,
    })
  ) {
    resolvedTaskBranch = taskBranchResolution(
      opts.resolvedTaskBranch,
      callerCwd,
      attachableTaskKey!,
      opts.ownerSession ?? sessionId(),
    )
    if (resolvedTaskBranch && !resolvedTaskBranch.worktree && worktreeTool?.create) {
      // A command-backed declaration cannot attach an existing ref; it retains
      // the prior new-branch behavior instead.
      resolvedTaskBranch = null
    }
  }
  const { attachedTree, claimTreePlan } = claimTreePlanForCandidate({
    candidate: resolvedTaskBranch,
    forbidsRepo,
    repoJob,
    hasWorktree: Boolean(opts.resume?.worktree),
    refusalMessage: taskBranchLandingTreeRefusal,
  })
  const existingBranch = resumePlan?.branch ?? resolvedTaskBranch?.branch
  assertBranchHasNoAliveOwner({
    branch: existingBranch,
    conversationRootId: resumePlan?.rootId ?? null,
    projectId: runProjectId,
  })
  const claimedCwd = repoJob ? null : callerCwd
  const claimedBranch = repoJob ? null : branchOf(callerCwd)
  const identity = claimIdentity(opts.resume)
  const updateReservedRun = () =>
    db()
      .query(
        `UPDATE run SET record_id=?, started_at=?, agent=?, job=?, repo=?, project_record_id=?, cwd=?, prompt_sha=?, spec_sha=?,
                        prompt_bytes=?, prompt_head=?, label=?, status='running', probe=?, retry_of_record_id=?,
                        route_reason=?, branch=?, parent_run_record_id=?, turn=?, vendor_session=?, docs_injected=?, doc_revisions=?, canon_sha=?,
                        launch_cwd=?, launch_seed=?, launch_key=?, task_record_id=?, launch_base=?, no_failover=?,
                        automatic_failover=?, agent_explicit=?, transport_explicit=?, review_ref=?, review_role=?, pid=?, mcp=?, transport=?
          WHERE record_id=? AND status='running' AND agent='(pending)' RETURNING record_id, number`,
      )
      .get(
        recordId,
        nowIso(),
        name,
        opts.job,
        runProjectName,
        runProjectId,
        claimedCwd,
        sha(prompt),
        sha(originalPrompt),
        Buffer.byteLength(prompt),
        head,
        opts.label ?? null,
        opts.probe ? 1 : 0,
        opts.retryOf ?? null,
        reason,
        claimedBranch,
        identity.parent_run_record_id,
        identity.turn,
        vendorSession,
        pack?.docs.length ?? 0,
        pack ? JSON.stringify(pack.docs.map((doc) => doc.revisionId)) : null,
        pack?.sha256 ?? null,
        launchCwd,
        launchSeed,
        launchKey,
        taskRecordId,
        launchBase,
        noFailover ? 1 : 0,
        ...explicitRunFlags(opts),
        ...reviewClaimBindings(opts),
        process.pid,
        storedMcpRequest(mcpRequest),
        transportName,
        opts.reserveId!,
      ) as { record_id: string; number: number }
  const insertClaimedRun = () =>
    db()
      .query(
        `INSERT INTO run (record_id, number, started_at, agent, job, repo, project_record_id, cwd, prompt_sha, spec_sha, prompt_bytes, prompt_head, label, status, session_id, probe, retry_of_record_id, route_reason, branch, parent_run_record_id, turn, vendor_session, docs_injected, doc_revisions, canon_sha,
                          launch_cwd, launch_seed, launch_key, task_record_id, launch_base, no_failover,
                          automatic_failover, agent_explicit, transport_explicit, review_ref, review_role, pid, mcp, transport, started_by_user_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'running',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING record_id, number`,
      )
      .get(
        recordId,
        nextRunNumber(db()),
        nowIso(),
        name,
        opts.job,
        runProjectName,
        runProjectId,
        claimedCwd,
        sha(prompt),
        sha(originalPrompt),
        Buffer.byteLength(prompt),
        head,
        opts.label ?? null,
        // A resumed turn inherits the owning session rather than taking the one that answered.
        resume.workspaceSource === 'retained'
          ? opts.resume!.sessionId
          : (opts.ownerSession ?? sessionId()),
        opts.probe ? 1 : 0,
        opts.retryOf ?? null,
        reason,
        claimedBranch,
        identity.parent_run_record_id,
        identity.turn,
        vendorSession,
        pack?.docs.length ?? 0,
        pack ? JSON.stringify(pack.docs.map((doc) => doc.revisionId)) : null,
        pack?.sha256 ?? null,
        launchCwd,
        launchSeed,
        launchKey,
        taskRecordId,
        launchBase,
        noFailover ? 1 : 0,
        ...explicitRunFlags(opts),
        ...reviewClaimBindings(opts),
        process.pid,
        storedMcpRequest(mcpRequest),
        transportName,
        startedByUserId,
      ) as { record_id: string; number: number }
  const claim = claimWithMigrationAdmission(input, () => {
    const claimedRow = claimableRow(opts.reserveId, updateReservedRun, insertClaimedRun)
    const claimed = { id: claimedRow.record_id, number: claimedRow.number }
    /**
     * A child that asked has finished that turn once its successor exists.
     *
     * The root is deliberately excluded here: it carries the conversation's
     * rolled-up outcome and is routing evidence, while a child is independently
     * excluded from routing by `parent_run_record_id IS NULL`. `ok` records what
     * happened without fabricating a failure or an operator stop: the worker
     * fulfilled its contract by asking, the question was ruled on, and the
     * conversation moved to a later turn. The root's counterpart is
     * `rollUpRootAndEnqueue`, which inherits the last turn's terminal status
     * once the chain has ended.
     *
     * Match the row's own facts even though continueRun already refuses an open
     * question. Keeping the answered-question and successor predicates here
     * makes this write incapable of retiring a genuinely waiting turn when
     * run() is called directly.
     */
    if (identity.resolveSupersededTurn) {
      resolveSupersededTurn(db(), opts.resume!.parent, opts.resume!.turn - 1)
    }
    if (opts.automaticFailover && opts.retryOf !== undefined) {
      closeRunChainQuestions(db(), opts.retryOf, QUESTION_CLOSE_ATTEMPT_FAILED_OVER)
    }
    const recordCarry = db().query(
      'INSERT INTO run_carried_ruling (record_id,run_record_id,question_record_id) VALUES (?,?,?)',
    )
    for (const id of carriedQuestionIds) recordCarry.run(newRecordId(), claimed.id, id)
    return claimed
  })
  const runToken = randomUUID()
  const inheritedKeepTree =
    resume.workspaceSource === 'retained'
      ? (() => {
          const parent = db()
            .query(
              'SELECT keep_tree,keep_tree_until,keep_tree_reason,started_at FROM run WHERE record_id=?',
            )
            .get(opts.resume!.parent) as {
            keep_tree: number
            keep_tree_until: string | null
            keep_tree_reason: string | null
            started_at: string
          } | null
          if (!parent?.keep_tree) return undefined
          const decision = keepTreeHold({
            keepTree: parent.keep_tree,
            keepTreeUntil: parent.keep_tree_until,
            startedAt: parent.started_at,
            now: nowIso(),
          })
          return {
            until: decision.held
              ? decision.until
              : 'expiredAt' in decision
                ? decision.expiredAt
                : parent.started_at,
            reason: parent.keep_tree_reason ?? 'explicit --keep-tree',
          }
        })()
      : undefined
  const keepTree = opts.keepTree ?? inheritedKeepTree
  db()
    .query(
      `UPDATE run SET stack=?, model=?, run_token=?, mcp=?, mcp_server=?,
                      mcp_connected=?, mcp_error=?, schema_path=?, lens=?, keep_tree=?,
                      keep_tree_until=?, keep_tree_reason=? WHERE record_id=?`,
    )
    .run(
      stackAt(callerCwd),
      opts.model ?? a.model,
      runToken,
      storedMcpRequest(mcpRequest),
      mcpConnection?.server ?? null,
      mcpConnection?.connected == null ? null : mcpConnection.connected ? 1 : 0,
      mcpConnection?.error ??
        (mcpMode ? 'no registered project identifies the canonical MCP server' : null),
      opts.schemaPath ?? null,
      opts.lens ?? null,
      keepTree ? 1 : 0,
      keepTree?.until ?? null,
      keepTree?.reason ?? null,
      claim.id,
    )
  const sandboxRoot = sandboxRootForRun(claim.id)
  const { scratchDir, runtimeDir } = runOwnedPaths(recordId, sandboxRoot.record_id, runsDir)
  mkdirSync(scratchDir, { recursive: true })
  prompt = `${replyFileInstruction(replySchemaName, scratchDir)}\n\n${prompt}`
  writeFileSync(join(dirname(promptPath), 'bound-prompt.txt'), prompt)
  db()
    .query('UPDATE run SET prompt_sha=?, prompt_bytes=? WHERE record_id=?')
    .run(sha(prompt), Buffer.byteLength(prompt), claim.id)
  writeDispatchState(claim.id, {
    deliverables: declaredDeliverables,
    timeoutMinutes: timeoutMinutes ?? null,
  })
  /**
   * A repository worker never runs in the caller's checkout.
   *
   * Cut AFTER the row exists, because the worktree is named by run id and the
   * id is what makes the mapping between a row and a directory total in both
   * directions. That ordering means a repository that cannot host a worktree
   * leaves a row behind — which is the right way round: the `finally` below
   * writes it terminal, so the failure is recorded rather than silent.
   */
  let worktree: Worktree | null = opts.resume?.worktree ?? null
  let carried: CarriedWorkingState | null = null
  let isolatedCwd: string | null = null
  let removeIsolatedCwd: (() => void) | null = null
  let provisionedMcpConfig: ReturnType<typeof prepareWorkerMcpConfig> | null = null
  let retargetDiagnostic: string | null = null
  let mcpSetupHeader: string | null = null
  let mcpTrustGranted = false,
    taskBranchAttachment = false
  let grokMcpEnvironment: Record<string, string> = {}
  const runtimeDirExisted = existsSync(runtimeDir)
  /**
   * Cutting the worktree can FAIL, and the row already exists by now.
   *
   * A directory that is not a git repository, or a worktree path already taken,
   * throws here — and this used to happen outside the try/finally below, so the
   * row stayed `running` for ever with no process behind it until the stale
   * sweep guessed at it half an hour later. The rule three lines into this
   * function is that a run always writes its own terminal state; that has to
   * hold for the setup as much as for the agent.
   */
  let cwd = callerCwd
  try {
    switch (claimTreePlan.mode) {
      case 'attach':
        worktree = attachedTree!
        taskBranchAttachment = true
        break
      case 'isolate': {
        // A self-contained job must not inherit the checkout it was launched
        // from. Read-only controls mutation, not visibility; the incident this
        // boundary closes was a reviewer reading the caller's HEAD and treating
        // it as part of an inline pack. An empty directory gives the process no
        // checkout at all, while launch_cwd retains project attribution.
        isolatedCwd = noRepoIsolatePath(claim.id, runsDir)
        removeIsolatedCwd = createIsolatedWorkerDirectory(isolatedCwd)
        cwd = isolatedCwd
        db().query('UPDATE run SET cwd=? WHERE record_id=?').run(cwd, claim.id)
        break
      }
      case 'create': {
        // A job that reads the repository must have a worktree, so a repository
        // it cannot be cut from is a hard failure.
        const tool = worktreeTool
        const repoRoot = repoRootOf(callerCwd)
        if (!repoRoot) throw new Error(`not a git repository: ${callerCwd}`)
        const toolLifecycle = resumeCreationLifecycle({
          hasCreate: Boolean(worktreeTool?.create),
          hasRecipe: Boolean(worktreeTool?.recipe),
          hasRecipePath: Boolean(worktreeTool?.recipePath),
        })
        const resumeCreation = resumeCreationOptions(resumePlan, toolLifecycle)
        const creationTool = resumeCreationTool(resumeCreation.useCreateTool, tool)
        const recordWorktree = (created: Worktree) => {
          const retryValidation = retryRootTreeValidation({
            kind: opts.resume?.kind ?? null,
            treePlan: resumePlan ?? null,
            readOnlyBase: opts.resume?.readOnlyBase ?? null,
          })
          if (retryValidation) {
            assertRetryRootWorkspace({
              worktree: created,
              expectedBranch: retryValidation.branch,
              validatedTip: retryValidation.tip,
              conversationRootId: claim.id,
              projectId: runProjectId,
              projectName: runProjectName,
              operation: 'creation',
            })
          }
          writeTransaction(() => {
            const result = db()
              .query(
                `UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=?, base_commit=?, worktree_source=?,
                        resource_teardown=CASE WHEN ?='recipe' THEN 'pending' ELSE resource_teardown END
                 WHERE record_id=?`,
              )
              .run(
                created.path,
                created.path,
                recordedBranch(created.branch),
                created.mintedBranch ?? null,
                coverageBase ?? created.base,
                created.source ?? null,
                created.source ?? null,
                claim.id,
              )
            if (result.changes !== 1)
              throw new Error(`run ${claim.id} could not record its worktree`)
            recordCreatedWorktreeClaims(db(), {
              rootRunId: sandboxRoot.record_id,
              runId: claim.id,
              projectId: runProjectId,
              owned: true,
              path: created.path,
              head: created.base,
              mintedBranch: created.mintedBranch ?? null,
              label: String(claim.id),
              claimedAt: nowIso(),
            })
          })
        }
        const recordRecipeResource: NonNullable<
          Parameters<typeof createWorkerWorktree>[0]['recordRecipeResource']
        > = (resource) => {
          writeTransaction(() => {
            const identity = {
              rootRunId: sandboxRoot.record_id,
              runId: claim.id,
              projectId: runProjectId,
              claimedAt: nowIso(),
            }
            recordDatabaseClaim(db(), {
              ...identity,
              provider: resource.provider,
              name: resource.name,
            })
          })
        }
        const claimRecipeServePort = () =>
          writeTransaction(() =>
            claimRecipePort(db(), {
              rootRunId: sandboxRoot.record_id,
              runId: claim.id,
              projectId: runProjectId,
              claimedAt: nowIso(),
              band: RECIPE_PORT_BAND,
            }),
          )
        const callerProject = projectAt(callerCwd)
        worktree = withWorktreeCreateLock(repoRoot, () => {
          assertBranchHasNoAliveOwner({
            branch: existingBranch,
            conversationRootId: resumePlan?.rootId ?? claim.id,
            projectId: runProjectId,
          })
          prepareResumeBranchIfNeeded(repoRoot, resumePlan)
          // The PROJECT owns its worktrees. A bare `git worktree add` here would
          // produce a directory with no .env, no vendor and no database, in which
          // every test the worker runs is meaningless and green. The isolation
          // module selects the declared lifecycle or Git fallback as one operation.
          const created = createWorkerWorktree({
            tool: creationTool,
            cwd: callerCwd,
            mainProjectPath: callerProject?.path ?? repoRoot,
            runId: claim.id,
            writes: writesJob,
            readOnlyBase: readOnlyBase!,
            seed,
            key: opts.key,
            baseRef:
              resumeCreation.baseRef ??
              reviewTarget?.commit ??
              opts.base ??
              (writesJob && !resolvedTaskBranch
                ? writerTreeBaseRef(creationTool, callerCwd, repoRoot, Boolean(opts.carry))
                : undefined),
            record: recordWorktree,
            detached: Boolean(reviewTarget),
            existingBranch: resumeCreation.existingBranch ?? resolvedTaskBranch?.branch,
            existingBranchTip: resumeCreation.existingBranchTip ?? resolvedTaskBranch?.tip,
            recordRecipeResource,
            claimRecipePort: claimRecipeServePort,
            mainStackConsumers: callerProject?.settings.mainStack?.consumers,
            mainStackRequiredServices: callerProject?.settings.mainStack?.requiredServices,
            mainStackProject: callerProject ?? undefined,
            provisionTimeoutMs: timeoutMs,
          })
          const restored = restoreResumeIfNeeded(created, resumePlan, claim.id)
          const current = db().query('SELECT status FROM run WHERE record_id=?').get(claim.id) as {
            status: string
          }
          if (current.status === 'stopped') {
            const cleanup = removeFor(restored, restored.repoRoot, false, false, claim.id)
            settleCreateTimeBranchCleanup(restored, claim.id)
            if (cleanup.removed)
              db().query('UPDATE run SET worktree=NULL WHERE record_id=?').run(claim.id)
            throw new Error(
              `run ${claim.id} was stopped during worktree creation; cleanup: ` +
                `${cleanup.removed ? 'removed' : cleanup.detail}`,
            )
          }
          try {
            // Carry only by request; resumes and explicit reviews have their own ancestry.
            if (
              shouldAssertCallerAncestry(Boolean(opts.carry), Boolean(resumePlan)) &&
              !resolvedTaskBranch &&
              (!reviewTarget || opts.carry) &&
              !namesRecordedRunTree({
                cwd: callerCwd,
                explicitCwd: opts.cwd !== undefined,
                base: opts.base,
                resume: opts.resume,
              })
            ) {
              assertCallerAncestry(callerCwd, restored)
            }
            carried =
              opts.carry && !resumePlan
                ? carryWorkingState(callerCwd, restored)
                : { base: restored.base, tracked: [], untracked: [] }
          } catch (e) {
            const cleanup = removeFor(restored, restored.repoRoot, false, false, claim.id)
            settleCreateTimeBranchCleanup(restored, claim.id)
            throw new Error(
              `${String((e as Error)?.message ?? e)}\n` +
                `incomplete worktree cleanup: ${cleanup.removed ? 'removed' : cleanup.detail}`,
            )
          }
          return restored
        })
        break
      }
      case 'caller':
        break
    }
    if (worktree) {
      const inheritedWorktree = worktree
      const recordWorktree = () => {
        if (resume.workspaceSource === 'retained' && !worktreeExists(inheritedWorktree.path)) {
          throw new Error(
            `resumed worktree ${inheritedWorktree.path} no longer exists after waiting for ` +
              `the project lifecycle lock`,
          )
        }
        if (!carried && resume.workspaceSource === 'retained') {
          const inherited = db()
            .query(
              `SELECT carry_base_commit, carry_tracked_paths, carry_untracked_paths
                 FROM run WHERE record_id=?`,
            )
            .get(opts.resume!.parent) as {
            carry_base_commit: string | null
            carry_tracked_paths: string | null
            carry_untracked_paths: string | null
          } | null
          if (
            inherited?.carry_base_commit &&
            inherited.carry_tracked_paths !== null &&
            inherited.carry_untracked_paths !== null
          ) {
            carried = {
              base: inherited.carry_base_commit,
              tracked: JSON.parse(inherited.carry_tracked_paths),
              untracked: JSON.parse(inherited.carry_untracked_paths),
            }
          }
        }
        if (opts.resume?.kind === 'retry-root' && writesJob) {
          assertRetryRootWorkspace({
            worktree: inheritedWorktree,
            expectedBranch: inheritedWorktree.branch,
            validatedTip: inheritedWorktree.base,
            conversationRootId: claim.id,
            projectId: runProjectId,
            projectName: runProjectName,
            operation: 'reuse',
          })
        }
        db()
          .query(
            `UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=?, base_commit=?, worktree_source=?, carry_happened=?,
                            carry_base_commit=?, carry_tracked_paths=?, carry_untracked_paths=? WHERE record_id=?`,
          )
          .run(
            inheritedWorktree.path,
            inheritedWorktree.path,
            recordedBranch(inheritedWorktree.branch),
            inheritedWorktree.mintedBranch ?? null,
            coverageBase ?? inheritedWorktree.base,
            inheritedWorktree.source ?? null,
            carried ? (carried.tracked.length + carried.untracked.length > 0 ? 1 : 0) : null,
            carried?.base ?? null,
            carried ? JSON.stringify(carried.tracked) : null,
            carried ? JSON.stringify(carried.untracked) : null,
            claim.id,
          )
      }
      if (resume.workspaceSource === 'retained') {
        withWorktreeLease(
          inheritedWorktree.repoRoot,
          inheritedWorktree.path,
          { session: sessionId(), what: `resume ${claim.id}` },
          () => withWorktreeCreateLock(inheritedWorktree.repoRoot, recordWorktree),
        )
      } else if (taskBranchAttachment) {
        try {
          withWorktreeLease(
            inheritedWorktree.repoRoot,
            inheritedWorktree.path,
            { session: sessionId(), what: `attach task branch for run ${claim.id}` },
            () =>
              withWorktreeCreateLock(inheritedWorktree.repoRoot, () => {
                assertBranchHasNoAliveOwner({
                  branch: inheritedWorktree.branch,
                  conversationRootId: claim.id,
                  projectId: resolvedTaskBranch!.projectId,
                })
                if (!worktreeExists(inheritedWorktree.path)) {
                  throw new Error(
                    `refusing to attach run ${claim.id}: retained worktree ` +
                      `${inheritedWorktree.path} no longer exists`,
                  )
                }
                const branch = branchOf(inheritedWorktree.path)
                const tip = gitContext(
                  inheritedWorktree.path,
                  'rev-parse',
                  '--verify',
                  'HEAD^{commit}',
                )
                if (branch !== inheritedWorktree.branch || tip !== resolvedTaskBranch?.tip) {
                  throw new Error(
                    `refusing to attach run ${claim.id}: ${inheritedWorktree.path} moved from ` +
                      `${inheritedWorktree.branch} at ${resolvedTaskBranch?.tip}\n` +
                      `invariant: Task branch resolution and attachment describe the same tree.\n` +
                      `cleared by: repeat the dispatch to resolve the task branch again`,
                  )
                }
                recordWorktree()
                appendRunEvent(claim.id, {
                  ts: nowIso(),
                  type: 'text',
                  text: `attached existing task branch ${inheritedWorktree.branch} at ${inheritedWorktree.path}`,
                })
              }),
            0,
          )
        } catch (error) {
          const message = String((error as Error)?.message ?? error)
          if (message.includes('waiting for this project')) {
            throw new Error(
              `${message}\n` +
                `invariant: Two concurrent runs or a landing never share one task branch tree.\n` +
                `cleared by: let the named holder finish, then repeat this dispatch`,
            )
          }
          throw error
        }
      } else {
        recordWorktree()
      }
      cwd = inheritedWorktree.path
      if (
        resume.isFirstTurn &&
        !(taskBranchAttachment && realpathOrSpelled(callerCwd) === realpathOrSpelled(worktree.path))
      ) {
        const caller = checkoutAliases(callerCwd)
        if (!caller) throw new Error(`could not resolve caller checkout root: ${callerCwd}`)
        retargetDiagnostic = caller.diagnostic
        // The project's worktree tool decides where the tree lives. Protect
        // that whole declared directory, obtained from the path it returned,
        // so a later turn cannot rebind an older sibling worktree beneath the
        // same root into the current destination.
        const declaredWorktreeRoot = dirname(worktree.path)
        const canonicalWorktreeRoot = realpathOrSpelled(declaredWorktreeRoot)
        try {
          prompt = retargetRepositoryPromptForDispatch(
            prompt,
            caller.roots,
            worktree.path,
            caller.caseInsensitive,
            [...new Set([declaredWorktreeRoot, canonicalWorktreeRoot])],
          )
        } catch (error) {
          throw new Error(
            [String((error as Error)?.message ?? error), caller.diagnostic]
              .filter(Boolean)
              .join('\n'),
          )
        }
      }
      // The original file remains the caller's resumable spec. The bound file
      // and row describe what was actually sent after the worktree had an
      // address, which is the evidence an audit needs.
      writeFileSync(join(dirname(promptPath), 'bound-prompt.txt'), prompt)
      db()
        .query('UPDATE run SET prompt_sha=?, prompt_bytes=? WHERE record_id=?')
        .run(sha(prompt), Buffer.byteLength(prompt), claim.id)
    }
    ;({
      provisionedMcpConfig,
      mcpSetupHeader,
      mcpTrustGranted,
      grokMcpEnvironment,
      mcpConnection,
      usingMcp,
    } = executeClaimedMcpPlan({
      plan: deferredCwdMcpPlan,
      callerCwd,
      agent: a,
      agentName: name,
      runtimeDir,
      runtimeDirExisted,
      sandboxRootId: sandboxRoot.record_id,
      runId: claim.id,
      runProjectId,
      runsDir,
      cwd,
      inherited: resume.workspaceSource === 'retained',
      writesJob,
      repoJob,
      mcpMode,
      mcpConnection,
      usingMcp,
    }))
  } catch (e) {
    removeIsolatedCwd?.()
    const why = errorTail(String((e as Error)?.message ?? e))
    try {
      // Setting a worktree up is orchestrator's job, so this shared harness failure
      // must publish the child and roll its outcome up to a continuation root.
      recordRunStartupFailure(claim.id, why, started)
    } finally {
      teardownTerminalRunResources(db(), claim.id)
    }
    throw Object.assign(new Error(`run ${claim.id} could not start: ${why}`), { runId: claim.id })
  }
  return {
    promptPath,
    outputPath,
    originalSchemaPath,
    textReplyContract,
    schemaPath,
    started,
    launchKey,
    runToken,
    claim: { ...claim, recordId },
    keepTree,
    scratchDir,
    worktree,
    changes: null,
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
    prompt,
    mcpConnection,
    usingMcp,
  }
}
