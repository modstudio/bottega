// concern: run-claim
/**
 * Knows run row claiming, repository tree creation under project locks,
 * provisioning, confinement preparation, and failed-claim teardown. Must not
 * know live worker processes, terminal outcomes, transports, or the CLI.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Agent } from './agents.ts'
import type { Pack } from './canon.ts'
import { checkoutAliases, realpathOrSpelled } from './checkout-identity.ts'
import { readStrictCodexSchema } from './codex-schema.ts'
import { TEXT_REPLY_SCHEMA } from './contract.ts'
import { db, nowIso, sessionId, writeTransaction } from './db.ts'
import { namesRecordedRunTree } from './dispatch-preflight.ts'
import { appendRunEvent } from './events.ts'
import { resolveSupersededTurn } from './failover.ts'
import { branchOf, git, gitContext, repoRootOf } from './git-environment.ts'
import { addedGrokTrustHeadings, grokTrustHeadings, grokTrustStorePath } from './grok-trust.ts'
import {
  assertGrokTrustEligible,
  type McpConnection,
  type McpMode,
  type McpRequest,
  mcpAttachRefusal,
  mcpConnectionFor,
  storedMcpRequest,
} from './mcp-preflight.ts'
import { readMcpConfig, wrongProjectReason } from './mcp-probe.ts'
import { withWorktreeCreateLock, withWorktreeLease } from './project-lock.ts'
import { projectAt, stackAt } from './projects.ts'
import { retargetRepositoryPromptForDispatch } from './prompt-retarget.ts'
import {
  claimRecipePort,
  RECIPE_PORT_BAND,
  recordCreatedWorktreeClaims,
  recordDatabaseClaim,
  recordSandboxDirectoryClaim,
  recordTrustEntryClaims,
} from './resource-claims.ts'
import { teardownTerminalRunResources } from './resource-ownership.ts'
import type { ResumeTreePlan } from './resume-tree.ts'
import { inferredReadOnlyKey } from './review-target.ts'
import {
  noRepoIsolatePath,
  type runFilePaths,
  runScratchDir,
  writeDispatchState,
} from './run-artifacts.ts'
import { errorTail, sha } from './run-process.ts'
import { prepareProjectGrokMcpScope } from './sandbox.ts'
import { resolveTaskBranch, type TaskBranchCandidate } from './task-branch.ts'
import { createWorkerWorktree, worktreeExists } from './worktree.ts'
import {
  assertCallerAncestry,
  type CarriedWorkingState,
  carryWorkingState,
  resolveReadOnlyBase,
} from './worktree-caller.ts'
import { createIsolatedWorkerDirectory, prepareWorkerMcpConfig } from './worktree-mcp.ts'
import { toolFor } from './worktree-preflight.ts'
import { type Changes, removeFor } from './worktree-remove.ts'
import type { Worktree } from './worktree-types.ts'

type RecreateResumeTreePlan = Extract<
  ResumeTreePlan,
  { action: 'recreate-on-branch' | 'recreate-then-restore' }
>

function prepareResumeBranchIfNeeded(
  repoRoot: string,
  plan: RecreateResumeTreePlan | undefined,
): void {
  if (plan?.action !== 'recreate-on-branch') return
  const current = gitContext(
    repoRoot,
    'rev-parse',
    '--verify',
    `refs/heads/${plan.branch}^{commit}`,
  )
  if (!current) git(['update-ref', `refs/heads/${plan.branch}`, plan.tip], repoRoot)
}

function resumeCreationOptions(
  plan: RecreateResumeTreePlan | undefined,
  tool: ReturnType<typeof toolFor>,
): {
  tool: ReturnType<typeof toolFor>
  baseRef: string | undefined
  existingBranch: string | undefined
  existingBranchTip: string | undefined
} {
  if (!plan)
    return { tool, baseRef: undefined, existingBranch: undefined, existingBranchTip: undefined }
  if (plan.action === 'recreate-on-branch') {
    return {
      tool: null,
      baseRef: undefined,
      existingBranch: plan.branch,
      existingBranchTip: plan.tip,
    }
  }
  return { tool, baseRef: plan.tip, existingBranch: undefined, existingBranchTip: undefined }
}

function restoreResumeIfNeeded(
  created: Worktree,
  plan: RecreateResumeTreePlan | undefined,
  runId: number,
): Worktree {
  return plan ? restoreResumedTree(created, plan, runId) : created
}

function taskBranchKey(
  launchKey: string | null,
  plan: RecreateResumeTreePlan | undefined,
): string | null {
  return plan ? null : launchKey
}

function restoreResumedTree(
  created: Worktree,
  plan: RecreateResumeTreePlan,
  runId: number,
): Worktree {
  if (plan.action === 'recreate-then-restore') {
    try {
      git(['reset', '--hard', plan.tip], created.path)
    } catch {
      // The postcondition below gives the one harness failure shape for both a
      // refused reset and a reset that landed anywhere except the retained tip.
    }
  }
  const actual = gitContext(created.path, 'rev-parse', '--verify', 'HEAD^{commit}')
  if (actual !== plan.tip) {
    const cleanup = removeFor(created, created.repoRoot, false, true, runId)
    throw new Error(
      `resumed tree postcondition failed: expected ${plan.tip}, got ${actual ?? '(unresolved)'}; ` +
        `cleanup: ${cleanup.removed ? 'removed tree and kept every branch' : cleanup.detail}`,
    )
  }
  return { ...created, base: plan.tip }
}

type ClaimOptions = {
  reserveId?: number
  schemaPath?: string
  job: string
  label?: string
  probe?: boolean
  retryOf?: number
  ownerSession?: string | null
  automaticFailover?: boolean
  review?: string
  model?: string
  lens?: string
  keepTree?: boolean
  noFailover?: boolean
  key?: string
  cwd?: string
  base?: string
  carry?: boolean
  resume?: {
    parent: number
    turn: number
    sessionId: string | null
    worktree: Worktree | null
    treePlan?: Extract<ResumeTreePlan, { action: 'recreate-on-branch' | 'recreate-then-restore' }>
  }
}

export type ClaimInput = {
  opts: ClaimOptions
  runsDir: string
  paths: ReturnType<typeof runFilePaths>
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
  runProjectId: number | null
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
  forbidsRepo: boolean
  reviewTarget: { branch: string; commit: string; base: string } | null
  coverageBase: string | null
  readOnlyBase: string | null
  deferredCwdMcpPreflight: boolean
  usingMcp: boolean
}

export type ClaimResult = {
  promptPath: string
  originalSchemaPath: string | undefined
  textReplyContract: boolean
  schemaPath: string | undefined
  started: number
  launchKey: string | null
  runToken: string
  claim: { id: number }
  keepTree: boolean
  scratchDir: string
  worktree: Worktree | null
  changes: Changes | null
  isolatedCwd: string | null
  removeIsolatedCwd: (() => void) | null
  provisionedMcpConfig: ReturnType<typeof prepareWorkerMcpConfig> | null
  retargetDiagnostic: string | null
  mcpSetupHeader: string | null
  mcpTrustGranted: boolean
  grokMcpEnvironment: Record<string, string>
  sandboxRunDir: string
  cwd: string
  prompt: string
  mcpConnection: McpConnection | null
  usingMcp: boolean
}

export async function claimRun(input: ClaimInput): Promise<ClaimResult> {
  let {
    opts,
    runsDir,
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
  } = input
  const claimedPrompt = opts.reserveId
    ? (
        db().query('SELECT prompt_path FROM run WHERE id=?').get(opts.reserveId) as {
          prompt_path: string | null
        } | null
      )?.prompt_path
    : null
  const promptPath = claimedPrompt ?? paths.prompt
  writeFileSync(promptPath, originalPrompt)
  // Beside the prompt it wraps, whatever that file is called: a detached run's
  // prompt path was named by detach() before this stamp existed.
  writeFileSync(promptPath.replace(/\.prompt\.txt$/, '.bound.txt'), prompt)

  /**
   * The return contract, written to disk because that is how both agents take
   * one: codex's `--output-schema` wants a path and grok's `--json-schema`
   * wants the text, which agents.ts reads back from the same file.
   *
   * A caller's own `--schema` still wins. `orch do implement --schema mine.json`
   * is a deliberate act by someone who wants a different contract, and silently
   * overriding it would make the flag a lie.
   */
  const originalSchemaPath =
    generatedSchema && !opts.schemaPath
      ? (() => {
          const p = join(runsDir, `${stamp}.schema.json`)
          writeFileSync(p, JSON.stringify(generatedSchema, null, 2))
          return p
        })()
      : opts.schemaPath
  const textReplyContract = !opts.schemaPath && generatedSchema === TEXT_REPLY_SCHEMA
  // Codex's --output-schema is OpenAI strict structured output. Its copy is
  // normalized beside the prompt; the caller's file remains byte-for-byte
  // untouched for Grok, whose --json-schema accepts ordinary JSON Schema.
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
  const inheritedLaunch = opts.resume
    ? (db()
        .query(
          `SELECT launch_cwd, launch_seed, launch_key, launch_base, no_failover
             FROM run WHERE id=?`,
        )
        .get(opts.resume.parent) as {
        launch_cwd: string | null
        launch_seed: string | null
        launch_key: string | null
        launch_base: string | null
        no_failover: number
      })
    : null
  const launchCwd = inheritedLaunch?.launch_cwd ?? callerCwd
  const launchSeed = inheritedLaunch?.launch_seed ?? seed ?? null
  // A read-only run's key is an address on its record, not an input to the
  // worktree lifecycle. Writing runs retain the explicit-key-only behaviour
  // enforced by preflight and consumed below by createWithTool.
  const attributedKey = writesJob
    ? (opts.key ?? null)
    : (opts.key ?? inferredReadOnlyKey(callerCwd))
  const launchKey = inheritedLaunch?.launch_key ?? attributedKey
  const launchBase = inheritedLaunch?.launch_base ?? opts.base ?? null
  const noFailover = inheritedLaunch ? !!inheritedLaunch.no_failover : !!opts.noFailover
  // A repository row has no artifact address until creation returns one.
  const claimedCwd = repoJob ? null : callerCwd
  const claimedBranch = repoJob ? null : branchOf(callerCwd)
  // A reserved row is FILLED IN, not inserted: the id is already in the
  // caller's hands and printed, so allocating a second one here would hand back
  // an id that never finishes.
  const claim = opts.reserveId
    ? (db()
        .query(
          // parent_run_id and turn are set HERE TOO, not only on the INSERT.
          //
          // A DETACHED resume claims its row through this path, and without these
          // two columns it came back as a fresh root: the chain silently forked,
          // `orch answer` on the original found the wrong latest turn, and the
          // roll-up wrote its outcome nowhere. The two claim paths must agree on
          // every column that means something, and these mean the most.
          `UPDATE run SET started_at=?, agent=?, job=?, repo=?, project_id=?, cwd=?, prompt_sha=?, spec_sha=?,
                          prompt_bytes=?, prompt_head=?, label=?, status='running', probe=?, retry_of=?,
                          route_reason=?, branch=?, parent_run_id=?, turn=?, vendor_session=?, docs_injected=?, doc_revisions=?, canon_sha=?,
                          launch_cwd=?, launch_seed=?, launch_key=?, launch_base=?, no_failover=?,
                          automatic_failover=?, review_ref=?, pid=?, mcp=?, transport=?
            WHERE id=? RETURNING id`,
        )
        .get(
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
          opts.resume?.parent ?? null,
          opts.resume ? opts.resume.turn : 1,
          // Known before spawn: minted (grok) or inherited on resume. A SIGKILL
          // or an exec.ts bootstrap failure never reaches the finally that used
          // to be the only write, and continue then refused a chain whose parent
          // already knew the id.
          vendorSession,
          pack?.docs.length ?? 0,
          pack ? JSON.stringify(pack.docs.map((doc) => doc.revisionId)) : null,
          pack?.sha256 ?? null,
          launchCwd,
          launchSeed,
          launchKey,
          launchBase,
          noFailover ? 1 : 0,
          opts.automaticFailover ? 1 : 0,
          opts.review ?? null,
          process.pid,
          storedMcpRequest(mcpRequest),
          transportName,
          opts.reserveId,
        ) as { id: number })
    : (db()
        .query(
          `INSERT INTO run (started_at, agent, job, repo, project_id, cwd, prompt_sha, spec_sha, prompt_bytes, prompt_head, label, status, session_id, probe, retry_of, route_reason, branch, parent_run_id, turn, vendor_session, docs_injected, doc_revisions, canon_sha,
                            launch_cwd, launch_seed, launch_key, launch_base, no_failover,
                            automatic_failover, review_ref, pid, mcp, transport)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,'running',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
        )
        .get(
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
          // A resumed turn INHERITS the owning session rather than taking the
          // one that answered. The chain is one unit of work and one thing to
          // judge, and letting a second session adopt it by answering a question
          // would be the ownership rule leaking through a new door — the same
          // door `--detach` had to be stopped from opening.
          opts.resume ? opts.resume.sessionId : (opts.ownerSession ?? sessionId()),
          opts.probe ? 1 : 0,
          opts.retryOf ?? null,
          reason,
          claimedBranch,
          opts.resume?.parent ?? null,
          opts.resume ? opts.resume.turn : 1,
          vendorSession,
          pack?.docs.length ?? 0,
          pack ? JSON.stringify(pack.docs.map((doc) => doc.revisionId)) : null,
          pack?.sha256 ?? null,
          launchCwd,
          launchSeed,
          launchKey,
          launchBase,
          noFailover ? 1 : 0,
          opts.automaticFailover ? 1 : 0,
          opts.review ?? null,
          process.pid,
          storedMcpRequest(mcpRequest),
          transportName,
        ) as { id: number })

  /**
   * A child that asked has finished that turn once its successor exists.
   *
   * The root is deliberately excluded here: it carries the conversation's
   * rolled-up outcome and is routing evidence, while a child is independently
   * excluded from routing by `parent_run_id IS NULL`. `ok` records what
   * happened without fabricating a failure or an operator stop: the worker
   * fulfilled its contract by asking, the question was ruled on, and the
   * conversation moved to a later turn. The root's counterpart is
   * `resolveRootFromLastTurn`, which inherits the last turn's terminal status
   * once the chain has ended.
   *
   * Match the row's own facts even though continueRun already refuses an open
   * question. Keeping the answered-question and successor predicates here
   * makes this write incapable of retiring a genuinely waiting turn when
   * run() is called directly.
   */
  if (opts.resume) {
    resolveSupersededTurn(db(), opts.resume.parent, opts.resume.turn - 1)
  }
  const runToken = randomUUID()
  const inheritedKeepTree = opts.resume
    ? Boolean(
        (
          db().query('SELECT keep_tree FROM run WHERE id=?').get(opts.resume.parent) as {
            keep_tree: number
          } | null
        )?.keep_tree,
      )
    : false
  const keepTree = Boolean(opts.keepTree) || inheritedKeepTree
  db()
    .query(
      `UPDATE run SET stack=?, model=?, run_token=?, mcp=?, mcp_server=?,
                      mcp_connected=?, mcp_error=?, schema_path=?, lens=?, keep_tree=? WHERE id=?`,
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
      claim.id,
    )
  const scratchDir = runScratchDir(claim.id)
  mkdirSync(scratchDir, { recursive: true })
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
  const changes: Changes | null = null
  let isolatedCwd: string | null = null
  let removeIsolatedCwd: (() => void) | null = null
  let provisionedMcpConfig: ReturnType<typeof prepareWorkerMcpConfig> | null = null
  let retargetDiagnostic: string | null = null
  let mcpSetupHeader: string | null = null
  let mcpTrustGranted = false,
    taskBranchAttachment = false
  let grokMcpEnvironment: Record<string, string> = {}
  const sandboxRoot = (
    db().query('SELECT COALESCE(parent_run_id,id) AS id FROM run WHERE id=?').get(claim.id) as {
      id: number
    }
  ).id
  const sandboxRunDir = join(runsDir, `sandbox-${sandboxRoot}`)
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
    const worktreeTool = repoJob ? toolFor(callerCwd) : null
    const resumePlan = opts.resume?.treePlan
    let resolvedTaskBranch: TaskBranchCandidate | null = null
    const attachableTaskKey = taskBranchKey(launchKey, resumePlan)
    if (repoJob && writesJob && !worktree && attachableTaskKey) {
      resolvedTaskBranch = resolveTaskBranch(callerCwd, attachableTaskKey)
      if (resolvedTaskBranch?.worktree) {
        worktree = resolvedTaskBranch.worktree
        taskBranchAttachment = true
      } else if (resolvedTaskBranch && worktreeTool?.create) {
        // A command-backed declaration owns Git creation and provisioning as
        // one operation. Until the register has a declared attach operation,
        // it cannot be handed an existing ref as though it created new branches
        // that way. Preserve the former new-branch behavior for these projects.
        resolvedTaskBranch = null
      }
    }
    const creating = repoJob && !worktree
    if (forbidsRepo) {
      // A self-contained job must not inherit the checkout it was launched
      // from. Read-only controls mutation, not visibility; the incident this
      // boundary closes was a reviewer reading the caller's HEAD and treating
      // it as part of an inline pack. An empty directory gives the process no
      // checkout at all, while launch_cwd retains project attribution.
      isolatedCwd = noRepoIsolatePath(claim.id, runsDir)
      removeIsolatedCwd = createIsolatedWorkerDirectory(isolatedCwd)
      cwd = isolatedCwd
      db().query('UPDATE run SET cwd=? WHERE id=?').run(cwd, claim.id)
    } else if (repoJob) {
      // A job that reads the repository must have a worktree, so a repository
      // it cannot be cut from is a hard failure.
      const tool = worktreeTool
      if (creating) {
        const repoRoot = repoRootOf(callerCwd)
        if (!repoRoot) throw new Error(`not a git repository: ${callerCwd}`)
        prepareResumeBranchIfNeeded(repoRoot, resumePlan)
        const resumeCreation = resumeCreationOptions(resumePlan, tool)
        const recordWorktree = (created: Worktree) => {
          writeTransaction(() => {
            const result = db()
              .query(
                'UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=?, base_commit=?, worktree_source=? WHERE id=?',
              )
              .run(
                created.path,
                created.path,
                reviewTarget?.branch ?? (created.branch || null),
                created.mintedBranch ?? null,
                coverageBase ?? created.base,
                created.source ?? null,
                claim.id,
              )
            if (result.changes !== 1)
              throw new Error(`run ${claim.id} could not record its worktree`)
            recordCreatedWorktreeClaims(db(), {
              rootRunId: sandboxRoot,
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
              rootRunId: sandboxRoot,
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
              rootRunId: sandboxRoot,
              runId: claim.id,
              projectId: runProjectId,
              claimedAt: nowIso(),
              band: RECIPE_PORT_BAND,
            }),
          )
        worktree = withWorktreeCreateLock(repoRoot, () => {
          // The PROJECT owns its worktrees. A bare `git worktree add` here would
          // produce a directory with no .env, no vendor and no database, in which
          // every test the worker runs is meaningless and green. The isolation
          // module selects the declared lifecycle or Git fallback as one operation.
          const created = createWorkerWorktree({
            tool: resumeCreation.tool,
            cwd: callerCwd,
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
                ? resolveReadOnlyBase(callerCwd, 'HEAD')
                : undefined),
            record: recordWorktree,
            detached: Boolean(reviewTarget),
            existingBranch: resumeCreation.existingBranch ?? resolvedTaskBranch?.branch,
            existingBranchTip: resumeCreation.existingBranchTip ?? resolvedTaskBranch?.tip,
            recordRecipeResource,
            claimRecipePort: claimRecipeServePort,
          })
          const restored = restoreResumeIfNeeded(created, resumePlan, claim.id)
          const current = db().query('SELECT status FROM run WHERE id=?').get(claim.id) as {
            status: string
          }
          if (current.status === 'stopped') {
            const cleanup = removeFor(restored, restored.repoRoot, false, false, claim.id)
            if (cleanup.removed) {
              db().query('UPDATE run SET worktree=NULL WHERE id=?').run(claim.id)
            }
            throw new Error(
              `run ${claim.id} was stopped during worktree creation; cleanup: ` +
                `${cleanup.removed ? 'removed' : cleanup.detail}`,
            )
          }
          try {
            // Carrying is opt-in, default off. That will look wrong: the
            // function exists so an architect iterating on unfinished work can
            // dispatch a run and have the worker see it. The asymmetry is what
            // decides it. Not carrying fails as a worker that lacks context and
            // says so — visible, recoverable, cheap. Carrying fails as another
            // author's half-finished work inside a diff that is then judged,
            // scored and possibly landed as the worker's — silent, and it
            // corrupts the evidence the whole system runs on. The case the
            // function exists for is still there: pass --carry.
            //
            // The ancestry guard is orthogonal: a behind-or-diverged caller is
            // refused whether or not carrying was requested.
            // An explicit review from trunk deliberately selects a branch that
            // need not descend from the caller. An overlay still comes only
            // from that branch's own checkout, where the ancestry guard remains
            // the protection against carrying reversions onto a newer tip.
            // A tree rebuilt for a resume holds the chain's own tip, which the
            // caller checkout need not contain; the ancestry guard protects new
            // dispatches only, and nothing is carried into a rebuilt resume.
            if (
              !resumePlan &&
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
            throw new Error(
              `${String((e as Error)?.message ?? e)}\n` +
                `incomplete worktree cleanup: ${cleanup.removed ? 'removed' : cleanup.detail}`,
            )
          }
          return restored
        })
      }
    }
    if (worktree) {
      const inheritedWorktree = worktree
      const recordWorktree = () => {
        if (opts.resume && !worktreeExists(inheritedWorktree.path)) {
          throw new Error(
            `resumed worktree ${inheritedWorktree.path} no longer exists after waiting for ` +
              `the project lifecycle lock`,
          )
        }
        if (!carried && opts.resume) {
          const inherited = db()
            .query(
              `SELECT carry_base_commit, carry_tracked_paths, carry_untracked_paths
                 FROM run WHERE id=?`,
            )
            .get(opts.resume.parent) as {
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
        db()
          .query(
            `UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=?, base_commit=?, worktree_source=?, carry_happened=?,
                            carry_base_commit=?, carry_tracked_paths=?, carry_untracked_paths=? WHERE id=?`,
          )
          .run(
            inheritedWorktree.path,
            inheritedWorktree.path,
            reviewTarget?.branch ?? (inheritedWorktree.branch || null),
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
      if (opts.resume) {
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
                const owner = db()
                  .query(
                    `SELECT id FROM run
                    WHERE branch=? AND id<>? AND status IN ('running','asking')
                      AND (project_id=? OR (project_id IS NULL AND repo=?))
                    LIMIT 1`,
                  )
                  .get(
                    inheritedWorktree.branch,
                    claim.id,
                    resolvedTaskBranch!.projectId,
                    resolvedTaskBranch!.projectName,
                  ) as { id: number } | null
                if (owner) {
                  throw new Error(
                    `refusing to attach run ${claim.id} to ${inheritedWorktree.path}: ` +
                      `run ${owner.id} is still using the task branch\n` +
                      `invariant: Two concurrent runs never share one task branch.\n` +
                      `cleared by: wait for run ${owner.id} to finish, then repeat this dispatch`,
                  )
                }
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
        !opts.resume &&
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
      writeFileSync(promptPath.replace(/\.prompt\.txt$/, '.bound.txt'), prompt)
      db()
        .query('UPDATE run SET prompt_sha=?, prompt_bytes=? WHERE id=?')
        .run(sha(prompt), Buffer.byteLength(prompt), claim.id)
    }
    if (deferredCwdMcpPreflight) {
      const project = projectAt(callerCwd)
      if (!project)
        throw new Error(`no registered project identifies MCP configuration for ${callerCwd}`)
      const config = prepareWorkerMcpConfig(cwd, project.path, Boolean(opts.resume))
      mcpSetupHeader = config.header
      provisionedMcpConfig = config
      const server = project.settings.mcpServer ?? project.name
      if (config.error) {
        mcpConnection = { server, connected: false, error: config.error }
      } else {
        const grokTrust = name === 'grok'
        const grokScope = prepareProjectGrokMcpScope(
          name,
          sandboxRunDir,
          Object.keys(readMcpConfig(cwd)),
          project.settings.workerMcpServers,
          mcpSetupHeader,
        )
        grokMcpEnvironment = grokScope.environment
        if (name === 'grok') {
          writeTransaction(() => {
            recordSandboxDirectoryClaim(db(), {
              rootRunId: sandboxRoot,
              runId: claim.id,
              projectId: runProjectId,
              path: sandboxRunDir,
              claimedAt: nowIso(),
            })
          })
        }
        mcpSetupHeader = grokScope.header
        const recorded = db()
          .query('SELECT id, cwd, worktree, worktree_source FROM run WHERE id=?')
          .get(claim.id) as {
          id: number
          cwd: string | null
          worktree: string | null
          worktree_source: string | null
        } | null
        if (grokTrust) {
          assertGrokTrustEligible(
            cwd,
            recorded,
            noRepoIsolatePath(recorded?.id ?? claim.id, runsDir),
          )
        }
        const beforeTrust = grokTrust ? grokTrustHeadings(grokMcpEnvironment) : []
        mcpTrustGranted = grokTrust
        // Record the attempt before doctor: the trusted invocation may write its
        // store and then fail, and that remains a grant orch made.
        if (grokTrust) db().query('UPDATE run SET mcp_trust_granted=1 WHERE id=?').run(claim.id)
        try {
          mcpConnection = mcpConnectionFor(
            name,
            cwd,
            server,
            grokTrust,
            repoJob,
            grokMcpEnvironment,
          )
        } finally {
          if (grokTrust) {
            const added = addedGrokTrustHeadings(beforeTrust, grokTrustHeadings(grokMcpEnvironment))
            writeTransaction(() => {
              db()
                .query('UPDATE run SET mcp_trust_path=? WHERE id=?')
                .run(added.length ? JSON.stringify(added) : null, claim.id)
              recordTrustEntryClaims(db(), {
                rootRunId: sandboxRoot,
                runId: claim.id,
                projectId: runProjectId,
                headings: added,
                storePath: grokTrustStorePath(grokMcpEnvironment),
                claimedAt: nowIso(),
              })
            })
          }
        }
      }
      if (
        mcpTrustGranted &&
        mcpConnection.connected === false &&
        /folder untrusted|repo-local server not started/i.test(mcpConnection.error ?? '')
      ) {
        throw new Error(
          `Grok remained untrusted after scoped trust for ${cwd}: ${mcpConnection.error}`,
        )
      }
      const mismatched = wrongProjectReason(server, mcpConnection.namesSeen ?? [])
      if (mismatched) {
        mcpConnection = { ...mcpConnection, connected: false, error: mismatched }
      }
      if (mcpConnection.connected === false && mcpMode === 'prefer') {
        mcpConnection = {
          ...mcpConnection,
          error: mcpConnection.error?.startsWith('wrong project:')
            ? mcpConnection.error
            : `mirror: ${mcpConnection.error ?? `server '${server}' could not be attached`}`,
        }
        usingMcp = false
      }
      db()
        .query(`UPDATE run SET mcp_server=?, mcp_connected=?, mcp_error=? WHERE id=?`)
        .run(
          mcpConnection.server,
          mcpConnection.connected == null ? null : mcpConnection.connected ? 1 : 0,
          mcpConnection.error,
          claim.id,
        )
      const refusal = mcpAttachRefusal(mcpConnection)
      if (refusal && mcpMode === 'require') throw new Error(refusal)
    } else if (mcpConnection?.connected === false && mcpMode === 'prefer') {
      mcpConnection = {
        ...mcpConnection,
        error: `mirror: ${mcpConnection.error ?? `server '${mcpConnection.server}' could not be attached`}`,
      }
      usingMcp = false
      db().query('UPDATE run SET mcp_error=? WHERE id=?').run(mcpConnection.error, claim.id)
    }
  } catch (e) {
    removeIsolatedCwd?.()
    const why = errorTail(String((e as Error)?.message ?? e))
    db()
      .query(
        // 'harness': setting a worktree up is orch's job, and failing at it says
        // nothing whatever about the agent that was about to be given it.
        `UPDATE run SET
           status=CASE WHEN status='stopped' THEN status ELSE 'failed' END,
           error=CASE WHEN status='stopped' THEN error ELSE ? END,
           failure_kind=CASE WHEN status='stopped' THEN failure_kind ELSE 'harness' END,
           latency_ms=? WHERE id=?`,
      )
      .run(why, Date.now() - started, claim.id)
    teardownTerminalRunResources(db(), claim.id)
    throw Object.assign(new Error(`run ${claim.id} could not start: ${why}`), { runId: claim.id })
  }

  return {
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
    prompt,
    mcpConnection,
    usingMcp,
  }
}
