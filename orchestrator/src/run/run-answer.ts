// concern: run-answer
/**
 * Knows questions, chain authority, rulings, retries, and detached resumed
 * turns. Must not know transports, worktrees, routing, reviews, or the CLI.
 */
import { existsSync, readFileSync } from 'node:fs'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { AnswerWaitingResult } from '../../../shared/orch-contract.ts'
import { pidAlive } from '../../../shared/process-identity.ts'
import { AGENTS } from '../agent/agent-registry.ts'
import { callerIdentityRefusal } from '../caller-classification.ts'
import { ANSWER_WORKING_FORMS } from '../cli/args.ts'
import { rulingPrompt } from '../contract/contract.ts'
import { dashboardCapabilityAuthorized } from '../dashboard-capability.ts'
import { callerIdentity, db, writableDb, writeTransaction } from '../database/db.ts'
import { job } from '../jobs/jobs.ts'
import { mcpRequestFromStored } from '../mcp/mcp-preflight.ts'
import type { ReviewRole } from '../review/review-role.ts'
import { chainTransport, retryModelForAgent, transportTurns } from '../route/failover.ts'
import { answerRulingRefusal } from '../workflow/autonomy.ts'
import { resolveAnswerRulings } from '../workflow/autonomy-scopes.ts'
import { keepTreeHold } from '../worktree/keep-tree-hold.ts'
import { latestCheckpoint, readTaskPointer } from './checkpoint.ts'
import {
  continuationCheckoutForAnswer,
  continuationCheckoutForRetry,
} from './continuation-checkout-service.ts'
import { appendQuestionDeliveries } from './question-delivery.ts'
import { questionOpenSql } from './question-open.ts'
import { enqueueQuestionRecord } from './question-outbox.ts'
import {
  type AnswerChannel,
  QUESTION_DELIVERY_MODE_LIVE,
  QUESTION_DELIVERY_MODE_RECORD_ONLY,
  QUESTION_DELIVERY_MODE_RESUME,
  QUESTION_DELIVERY_MODE_RETRY,
  QUESTION_DELIVERY_OUTCOME_DELIVERED,
  QUESTION_DELIVERY_OUTCOME_FAILED,
} from './question-vocabulary.ts'
import { answerAttributions } from './ruling-attribution.ts'
import { answerAuthorityDecision } from './run-answer-authority.ts'
import { answerRunLivenessRefusal } from './run-answer-liveness.ts'
import {
  answerResumeUnavailable,
  answerResumeWorker,
  reportAnswerResume,
} from './run-answer-resume.ts'
import { KEEP_RUN_FILES_DAYS, readDispatchState, runScratchDir } from './run-artifacts.ts'
import {
  adoptRunMutation,
  auditRunMutation,
  authorizeRunMutation,
  type RootAuthority,
  reauthorizeRunMutation,
  runMutationActor,
} from './run-authority.ts'
import {
  continuationInstructionsForFreshRetry,
  continueRun,
  follow,
  type RunControlPresentation,
  refuseEscapedChain,
  reportContinuedRun,
  resumeLaunchForRoot,
} from './run-control.ts'
import { detach } from './run-dispatch.ts'
import { packedResumePrompt } from './run-resume-prompt.ts'

const RUN_STATUS_SQL = 'SELECT status FROM run WHERE record_id = ?'

import {
  previousAttemptTaskPointer,
  renderWritingRetryPrompt,
  retryConversationPath,
  retryTarget,
  retryTransport,
} from './run-retry.ts'
import { resolveRetryTree, resolveWritingRetryWorkspace } from './run-retry-workspace.ts'
import { assertAgentWorkRun } from './synthetic-lifecycle-job.ts'

type RunAnswerHelpers = {
  argvResumeLimit(agentName: string): number | undefined
  presentation: RunControlPresentation
  dispatch?: typeof detach
  dashboardAuthorized?: () => boolean
}
type RunFlags = { detach: boolean; follow: boolean; quiet: boolean }

function allowsPartialRecordOnly(input: AnswerRunInput, ownersLive: boolean): boolean {
  return Boolean(input.allowPartialRecordOnly && input.recordOnly && !ownersLive)
}

function incompleteRulingsRefusal(
  openCount: number,
  answerCount: number,
  input: AnswerRunInput,
  ownersLive: boolean,
): string | null {
  if (answerCount === openCount || allowsPartialRecordOnly(input, ownersLive)) return null
  return (
    `${openCount} question(s) open but ${answerCount} ruling(s) given. ` +
    'For multiple questions, pass every --q<id> in a single command. ' +
    'A worker resumed with a question unanswered will guess, which is the ' +
    'one thing this is here to prevent.'
  )
}

function answerResult(
  outcome: AnswerWaitingResult['outcome'],
  runId: string,
  runNumber: number,
  resumedAs: string | null,
): AnswerWaitingResult {
  const resumedNumber =
    resumedAs === null
      ? null
      : (db()
          .query<{ number: number }, [string]>('SELECT number FROM run WHERE record_id=?')
          .get(resumedAs)?.number ?? null)
  return {
    outcome,
    run_record_id: runId,
    run_number: runNumber,
    resumed_record_id: resumedAs,
    resumed_number: resumedNumber,
  }
}

export type AnswerRunInput = {
  rulings: string | { questionId: string; text: string; fromOperator: boolean }[]
  allowPartialRecordOnly?: boolean
  fromOperator: boolean
  channel: AnswerChannel
  recordOnly: boolean
  json: boolean
  flags: RunFlags
}
type OpenQuestion = {
  record_id: string
  number: number
  question: string
  awaiting_operator_at: string | null
  owner_id: string
  owner_status: string
  owner_pid: number | null
}
type AnsweredQuestion = {
  number: number
  record_id: string
  question: string
  answer: string
  fromOperator: boolean
}

type RecordedRuling = { number: number; record_id: string; question: string; answer: string }

function answeredQuestion(
  question: OpenQuestion,
  answer: string,
  fromOperator: boolean,
): AnsweredQuestion {
  return {
    number: question.number,
    record_id: question.record_id,
    question: question.question,
    answer,
    fromOperator,
  }
}

function wrongQuestionChain(questionId: string, rootRecordId: string): string {
  return `--q${questionId} belongs to run ${rootRecordId}, not this chain`
}

type AnswerRootRow = {
  number: number
  record_id: string
  agent: string
  job: string
  cwd: string | null
  worktree: string | null
  branch: string | null
  base_commit: string | null
  vendor_session: string | null
  status: string
  session_id: string | null
  turn: number
  parent_run_record_id: string | null
  worktree_source: 'recipe' | 'git' | 'clone' | 'readonly_recipe' | null
  evidence_excluded: string | null
  repo: string | null
  launch_key: string | null
}

function answerRoot(requestedId: string): AnswerRootRow | null {
  return db()
    .query(
      `SELECT root.record_id, root.number, root.record_id, root.agent, root.job, root.cwd, root.worktree, root.branch,
          root.base_commit, root.vendor_session, root.status, root.session_id,
          root.turn, root.parent_run_record_id, root.worktree_source, root.evidence_excluded, root.repo,
          root.launch_key
     FROM run requested
     JOIN run root ON root.record_id = COALESCE(requested.parent_run_record_id, requested.record_id)
    WHERE requested.record_id = ?`,
    )
    .get(requestedId) as AnswerRootRow | null
}

function requireAnswerAuthority(
  requestedId: string,
  channel: AnswerChannel,
  fromOperator: boolean,
  dashboardAuthorized: boolean,
  authority: RootAuthority,
) {
  const decision = answerAuthorityDecision({
    channel,
    fromOperator,
    sessionIdPresent: process.env.CLAUDE_CODE_SESSION_ID !== undefined,
    depthPresent: process.env.BOTTEGA_DEPTH !== undefined,
    dashboardAuthorized,
    owner: authority.owner,
    actor: authority.actor,
    ownerProcess: authority.ownerProcess,
    ownerLastSeenAt: authority.ownerLastSeenAt,
    chainLastActivityAt: authority.chainLastActivityAt,
    coordinatorRun: authority.coordinatorRun,
    now: authority.now,
    windowMs: authority.windowMs,
  })
  if (decision.kind !== 'refuse') return decision
  if (decision.code === 'operator-attribution')
    throw new Error('--channel ui requires --from-operator')
  if (decision.code === 'dashboard-capability')
    throw new Error('--channel ui requires the dashboard capability')
  if (decision.code === 'session-marker')
    throw new Error(`--channel ui is refused when ${decision.actor} is set`)
  throw new Error(
    decision.actor
      ? `run ${requestedId} is owned by session ${decision.owner}; current session ${decision.actor} cannot answer it (owner active within the window)`
      : `run ${requestedId} is owned by session ${decision.owner}; ${callerIdentityRefusal(callerIdentity(), 'answer')}`,
  )
}

function readOpenQuestions(id: string, status: string): OpenQuestion[] {
  const open = db()
    .query(
      `SELECT q.record_id,q.number,q.question,q.awaiting_operator_at,
              r.record_id owner_id, r.status owner_status, r.pid owner_pid
     FROM question q JOIN run r ON r.record_id = q.run_record_id
    WHERE (r.record_id = ? OR r.parent_run_record_id = ?) AND ${questionOpenSql('q')}
    ORDER BY q.number`,
    )
    .all(id, id) as OpenQuestion[]
  if (open.length) return open
  const asked = db()
    .query(
      `SELECT COUNT(*) n FROM question q JOIN run r ON r.record_id = q.run_record_id
      WHERE r.record_id = ? OR r.parent_run_record_id = ?`,
    )
    .get(id, id) as { n: number }
  throw new Error(
    asked.n
      ? `run ${id} has already been ruled on; its current status is ${status}`
      : `run ${id} has no questions to answer; its current status is ${status}`,
  )
}

function requireAnswerableLiveness(
  id: string,
  row: { status: string; evidence_excluded: string | null },
  open: OpenQuestion[],
): void {
  const refusal = answerRunLivenessRefusal(
    { status: row.status, voided: row.evidence_excluded !== null },
    open,
  )
  if (refusal === null) return
  throw new Error(
    `run ${id} is ${refusal}. ` +
      'invariant: a ruling resumes a live chain; a terminal chain is retried or abandoned. ' +
      `${PLATFORM_SLUG} run retry ${id} --agent <name> (carries the recorded ruling) or ${PLATFORM_SLUG} run abandon ${id}`,
  )
}

function reportUnownedAdoption(
  id: string,
  owner: string | null,
  callerSession: string | null,
  ownerAuthorized: boolean,
): void {
  if (owner || !callerSession || !ownerAuthorized) return
  console.error(
    `run ${id} is unowned; session ${callerSession} may rule and will adopt the chain, ` +
      'and that answering identity will be recorded',
  )
}

async function refuseUserRuling(
  project: string | null,
  launchKey: string | null,
  fromOperator: boolean,
): Promise<void> {
  if (!project) return
  const rulings = await resolveAnswerRulings(project, launchKey)
  const refusal = answerRulingRefusal(rulings, fromOperator)
  if (refusal) throw new Error(refusal)
}

async function requireRulingAttributions(
  row: Pick<AnswerRootRow, 'repo' | 'launch_key'>,
  input: AnswerRunInput,
): Promise<boolean> {
  if (!Array.isArray(input.rulings)) {
    await refuseUserRuling(row.repo, row.launch_key, input.fromOperator)
    return input.fromOperator
  }
  for (const ruling of input.rulings) {
    await refuseUserRuling(row.repo, row.launch_key, ruling.fromOperator)
  }
  return input.rulings.some((ruling) => ruling.fromOperator)
}

function requireAnswerRun<Row>(row: Row | null, requestedId: string): Row {
  if (!row) throw new Error(`no run ${requestedId}`)
  return row
}

function latestRetryTurn(
  id: string,
  rootId: string,
  hasRecordedRulings: boolean,
): { record_id: string; status: string } {
  const latest = db()
    .query(
      `SELECT record_id,status FROM run WHERE record_id=? OR parent_run_record_id=? ORDER BY turn DESC,number DESC LIMIT 1`,
    )
    .get(rootId, rootId) as { record_id: string; status: string }
  if (latest.status !== 'asking' || hasRecordedRulings) return latest
  const questions = db()
    .query(
      `SELECT q.number,q.question FROM question q JOIN run r ON r.record_id=q.run_record_id
       WHERE (r.record_id=? OR r.parent_run_record_id=?) AND ${questionOpenSql('q')} ORDER BY q.number`,
    )
    .all(rootId, rootId) as { number: number; question: string }[]
  throw new Error(
    `run ${id} is asking with open questions: ${questions.map((q) => `q${q.number}: ${q.question}`).join('; ')}. ` +
      `Answer them, or ${PLATFORM_SLUG} run abandon ${id}`,
  )
}

type RetryRunRow = {
  record_id: string
  root_record_id: string
  agent: string
  job: string
  cwd: string | null
  root_cwd: string | null
  root_base_commit: string | null
  prompt_path: string | null
  probe: number
  status: string
  failure_kind: string | null
  mcp: number | null
  mcp_error: string | null
  schema_path: string | null
  model: string | null
  lens: string | null
  review_role: ReviewRole | null
  review_ref: string | null
  launch_cwd: string | null
  launch_seed: string | null
  launch_key: string | null
  launch_base: string | null
  no_failover: number
  keep_tree: number
  keep_tree_until: string | null
  keep_tree_reason: string | null
  started_at: string
  repo: string | null
  project_record_id: string | null
  branch_kept: string | null
  agent_explicit: number
  branch_kept_tip: string | null
}

function retryReviewBindings(row: Pick<RetryRunRow, 'lens' | 'review_role'>) {
  return { lens: row.lens ?? undefined, reviewRole: row.review_role ?? undefined }
}

function retryAgentBindings(
  row: Pick<RetryRunRow, 'root_record_id' | 'agent' | 'agent_explicit' | 'model'>,
  options: { agent?: string; model?: string },
) {
  const neverStarted = row.agent === '(pending)'
  const agent = options.agent ?? (neverStarted ? undefined : row.agent)
  if (!agent)
    return {
      agent,
      agentExplicit: false,
      model: options.model,
      transport: undefined,
      neverStarted,
    }
  return {
    agent,
    agentExplicit: Boolean(options.agent || row.agent_explicit),
    model: retryModelForAgent(row.agent, row.model, agent, options.model),
    transport: retryTransport(agent !== row.agent, agent, transportTurns(row.root_record_id)),
    neverStarted,
  }
}

function retryTreeForNeverStarted<T>(neverStarted: boolean, cwd: string, resolve: () => T) {
  if (neverStarted) return { cwd, resume: undefined }
  return resolve()
}

function writingRetryWorkspace(
  id: string,
  row: RetryRunRow,
  needed: boolean,
  strandedRecordOnly: boolean,
) {
  if (!needed) return null
  return resolveWritingRetryWorkspace({
    id,
    rootId: row.root_record_id,
    job: row.job,
    launchKey: row.launch_key,
    repo: row.repo,
    projectId: row.project_record_id,
    branchKept: row.branch_kept,
    branchKeptTip: row.branch_kept_tip,
    strandedRecordOnly,
  })
}

export async function retryRun(
  id: string,
  options: { agent?: string; model?: string; flags: RunFlags },
  helpers: RunAnswerHelpers,
): Promise<void> {
  let retryAuthority = authorizeRunMutation(id, 'retry')
  const row = db()
    .query(
      `SELECT requested.record_id, COALESCE(requested.parent_run_record_id,requested.record_id) root_record_id,
          requested.agent, requested.job, requested.cwd, requested.prompt_path,
          requested.probe, requested.status, requested.failure_kind, requested.mcp, requested.mcp_error,
          requested.schema_path, requested.model, requested.lens, requested.review_role, COALESCE(requested.review_ref, root.review_ref) review_ref, requested.launch_cwd,
          requested.launch_seed, requested.launch_key, requested.launch_base, requested.no_failover, requested.keep_tree, requested.keep_tree_until, requested.keep_tree_reason,
          requested.started_at, root.repo, root.project_record_id, root.cwd root_cwd,
          root.base_commit root_base_commit, root.branch_kept, root.branch_kept_tip, root.agent_explicit
     FROM run requested JOIN run root ON root.record_id=COALESCE(requested.parent_run_record_id,requested.record_id)
     WHERE requested.record_id = ?`,
    )
    .get(id) as RetryRunRow | null
  if (!row) throw new Error(`no run ${id}`)
  assertAgentWorkRun(id, row.job, 'retried')
  // A writing job already has a worktree and a vendor session. Retry would
  // wrap the prompt again and cut a fresh tree beside the one holding the
  // partial edit. Continue the same conversation in the same tree instead.
  const recordedRulings = db()
    .query(
      `SELECT q.number,q.record_id,q.question,q.answer
     FROM question q JOIN run owner ON owner.record_id = q.run_record_id
    WHERE (owner.record_id = ? OR owner.parent_run_record_id = ?)
      AND q.delivery_pending_at IS NOT NULL AND q.answer IS NOT NULL
    ORDER BY q.number`,
    )
    .all(row.root_record_id, row.root_record_id) as RecordedRuling[]
  const writesRepo = Boolean(job(row.job).needs.writesRepo)
  const readsRepo = Boolean(job(row.job).needs.readsRepo)
  const bindings = retryAgentBindings(row, options)
  const { agent, neverStarted } = bindings
  const preliminaryPath = retryConversationPath(
    writesRepo,
    recordedRulings.length > 0,
    agent,
    row.agent,
    neverStarted,
  )
  if (preliminaryPath?.action === 'continue') {
    const resumed = await continueRun(id, undefined, helpers.argvResumeLimit)
    auditRunMutation(
      retryAuthority,
      'retry',
      `continued as run ${resumed.childId}`,
      db(),
      resumed.childId,
    )
    await reportContinuedRun(resumed.childId, resumed.job, options.flags, helpers.presentation)
    return
  }
  if (!row.prompt_path || !existsSync(row.prompt_path)) {
    throw new Error(
      `run ${id} has no prompt on disk — it predates prompt capture, or the file has aged out ` +
        `after ${KEEP_RUN_FILES_DAYS} days. Nothing to re-send.`,
    )
  }
  const latestTurn = latestRetryTurn(id, row.root_record_id, recordedRulings.length > 0)
  const latestCheckout = db()
    .query(
      `SELECT cwd,worktree,base_commit FROM run
       WHERE record_id=? OR parent_run_record_id=? ORDER BY turn DESC,number DESC LIMIT 1`,
    )
    .get(row.root_record_id, row.root_record_id) as {
    cwd: string | null
    worktree: string | null
    base_commit: string | null
  }
  const checkout = continuationCheckoutForRetry(neverStarted, {
    rootId: row.root_record_id,
    requiresRepo: readsRepo,
    latestCwd: latestCheckout.cwd,
    rootCwd: row.root_cwd,
    rootRepo: row.repo,
  })
  const instructions = continuationInstructionsForFreshRetry(writesRepo, id, row.root_record_id)
  // The same agent remains the default. An explicit replacement gets a fresh
  // vendor conversation while the retained writing workspace travels with it.
  const workspace = writingRetryWorkspace(
    id,
    row,
    preliminaryPath.action === 'needs-writing-workspace',
    recordedRulings.length > 0 && latestTurn.status === 'asking',
  )
  console.error(
    `— retrying run ${id} (${row.agent}/${row.job}` +
      (row.failure_kind ? `, ${row.failure_kind}` : '') +
      `)${retryTarget(agent)}`,
  )
  retryAuthority = writeTransaction(() => {
    retryAuthority = reauthorizeRunMutation(retryAuthority, 'retry')
    return adoptRunMutation(retryAuthority, 'retry')
  })
  const retryTree = retryTreeForNeverStarted(neverStarted, row.cwd ?? process.cwd(), () =>
    resolveRetryTree({
      rootId: row.root_record_id,
      projectName: row.repo,
      projectPath: checkout!.project?.path ?? null,
      readsRepo,
      writesRepo,
      checkoutCwd: checkout!.cwd,
      recordedWorktree: latestCheckout.worktree ?? latestCheckout.cwd,
      baseCommit: latestCheckout.base_commit ?? row.root_base_commit,
      agent: agent!,
      sessionId: retryAuthority.owner,
    }),
  )
  // Detached and followed, exactly like `do`. A retry is usually started
  // BECAUSE the first attempt died; running it as a child of this process
  // would leave it dying the same way.
  const originalPrompt = readFileSync(row.prompt_path, 'utf8')
  const renderedRulings = recordedRulings.length ? rulingPrompt(recordedRulings) : null
  const retryPrompt = workspace
    ? renderWritingRetryPrompt({
        originalSpec: originalPrompt,
        continuationInstructions: instructions,
        rulings: renderedRulings,
        commit: workspace.commit,
        taskPointer: previousAttemptTaskPointer({
          checkpoint: latestCheckpoint(db(), row.root_record_id)?.task_pointer ?? null,
          latestScratch: readTaskPointer(runScratchDir(latestTurn.record_id)),
          rootScratch: readTaskPointer(runScratchDir(row.root_record_id)),
        }),
      })
    : renderedRulings
      ? `${originalPrompt}\n\n---\n\n${renderedRulings}`
      : originalPrompt
  const dispatchState = readDispatchState(row.root_record_id)
  const resumeLaunch = resumeLaunchForRoot(row.root_record_id)
  let newId: string
  try {
    newId = await (helpers.dispatch ?? detach)(
      row.job,
      retryPrompt,
      {
        agent,
        agentExplicit: bindings.agentExplicit,
        schema: row.schema_path ?? undefined,
        mcp: mcpRequestFromStored(row.mcp, row.mcp_error),
        model: bindings.model,
        ...retryReviewBindings(row),
        review: row.review_ref ?? undefined,
        probe: !!row.probe,
        retryOf: id,
        cwd: workspace?.cwd ?? retryTree.cwd,
        repo: row.repo ?? undefined,
        seed: row.launch_seed ?? undefined,
        key: row.launch_key ?? undefined,
        base: resumeLaunch.base,
        launchBase: row.launch_base ?? undefined,
        noFailover: !!row.no_failover,
        transport: bindings.transport,
        keepTree: row.keep_tree
          ? (() => {
              const decision = keepTreeHold({
                keepTree: row.keep_tree,
                keepTreeUntil: row.keep_tree_until,
                startedAt: row.started_at,
                now: new Date().toISOString(),
              })
              return {
                until: decision.held
                  ? decision.until
                  : 'expiredAt' in decision
                    ? decision.expiredAt
                    : row.started_at,
                reason: row.keep_tree_reason ?? 'explicit --keep-tree',
              }
            })()
          : undefined,
        deliverables: dispatchState.deliverables,
        timeoutMinutes: dispatchState.timeoutMinutes ?? undefined,
        resume: workspace
          ? {
              kind: 'retry-root',
              parent: row.root_record_id,
              agent: agent!,
              retireAsking: recordedRulings.length > 0 && latestTurn.status === 'asking',
              turn: 1,
              sessionId: retryAuthority.owner,
              worktree: workspace.worktree,
              treePlan: workspace.treePlan,
            }
          : retryTree.resume,
      },
      agent,
    )
  } catch (error) {
    appendQuestionDeliveries(
      recordedRulings.map((ruling) => ruling.record_id),
      {
        runId: null,
        mode: QUESTION_DELIVERY_MODE_RETRY,
        outcome: QUESTION_DELIVERY_OUTCOME_FAILED,
        at: new Date(Date.now()).toISOString(),
        error: (error as Error).message,
      },
    )
    throw error
  }
  if (recordedRulings.length) {
    appendQuestionDeliveries(
      recordedRulings.map((ruling) => ruling.record_id),
      {
        runId: newId,
        mode: QUESTION_DELIVERY_MODE_RETRY,
        outcome: QUESTION_DELIVERY_OUTCOME_DELIVERED,
        at: new Date(Date.now()).toISOString(),
      },
    )
  }
  auditRunMutation(retryAuthority, 'retry', `retried as run ${newId}`, db(), newId)
  console.error(`— run ${newId} is retry of ${id}`)
  await follow(newId, options.flags.quiet, true, helpers.presentation)
}
/**
 * Rule on what a worker asked, and set it going again.
 *
 * The ruling RESUMES the worker's own session rather than starting a new run,
 * which is the entire reason escalation is affordable here: everything the
 * worker had read is still in its head, so a design question costs one short
 * turn instead of a second full survey of the code. Starting fresh would make
 * asking more expensive than guessing, and a channel that costs more than
 * guessing does not get used.
 */
export async function answerRun(
  requestedId: string,
  input: AnswerRunInput,
  helpers: RunAnswerHelpers,
): Promise<AnswerWaitingResult> {
  const row = requireAnswerRun(answerRoot(requestedId), requestedId)
  const hasOperatorRuling = await requireRulingAttributions(row, input)
  const id = row.record_id
  refuseEscapedChain(id)
  writableDb()
  let answerAuthority = runMutationActor(requestedId)
  const authorityDecision = requireAnswerAuthority(
    requestedId,
    input.channel,
    hasOperatorRuling,
    (helpers.dashboardAuthorized ?? dashboardCapabilityAuthorized)(),
    answerAuthority,
  )
  if (authorityDecision.kind === 'allow-as-operator')
    answerAuthority = { ...answerAuthority, actor: authorityDecision.actor }
  /**
   * Questions are collected ACROSS THE WHOLE CHAIN, not just off the root.
   *
   * A worker that blocks on turn two records its questions against the CHILD
   * row while the roll-up marks the ROOT blocked. Looking only at the root
   * found nothing to answer and looking at the child was refused as
   * non-root — so a conversation that asked twice could not be continued at
   * all. Found in review, and it is the shape every multi-turn escalation
   * takes after the first.
   */
  const open = readOpenQuestions(id, row.status)

  // A ruling resumes a live chain. Stopped, failed, stale and voided roots
  // used to record the answer and spawn a new turn, which is retry's job.
  requireAnswerableLiveness(id, row, open)

  // A last-seen timeout used to make a question appear adoptable, and this
  // command then accepted the adoption. Only the architect session that
  // dispatched the conversation has standing to change its specification.
  const callerSession = answerAuthority.actor
  reportUnownedAdoption(
    id,
    row.session_id,
    callerSession,
    authorityDecision.kind === 'allow-as-owner',
  )

  /**
   * TWO WAYS A QUESTION ARRIVES, and they are answered differently.
   *
   * `blocked` means the worker ended its turn and is waiting to be resumed —
   * the ruling has to start it again. `running` means the worker is ALIVE and
   * sitting inside an `ask_orchestrator` tool call, so writing the answer is
   * the entire delivery: it is polling for exactly that row, and resuming a
   * process that never stopped would start a second worker on the same
   * worktree.
   *
   * This is the defect the live channel shipped with. Questions asked through
   * MCP land against a `running` run, and this command accepted nothing but
   * `blocked` — so the tool could never be answered and every live question
   * ran to its timeout. The headline feature did not work end to end, and the
   * test that "proved" it wrote the answer with raw SQL, bypassing the very
   * guard that was refusing it.
   */
  const live = open.filter(
    (q) => (q.owner_status === 'running' || q.owner_status === 'asking') && pidAlive(q.owner_pid),
  )
  const stopped = open.filter((q) => !live.includes(q))
  if (live.length && stopped.length) {
    const list = (questions: typeof open) =>
      questions.map((q) => `q${q.number} (run ${q.owner_id}, ${q.owner_status})`).join(', ')
    throw new Error(
      `run ${id} has questions owned by both live and stopped turns. ` +
        `Live: ${list(live)}. Stopped: ${list(stopped)}. Refusing to rule; inspect the run chain.`,
    )
  }
  const ownersLive = live.length > 0
  const recordOnly = input.recordOnly
  const skipResume = recordOnly && !ownersLive
  if (
    !ownersLive &&
    !stopped.every((q) => q.owner_status === 'asking' || q.owner_status === 'running')
  ) {
    const states = stopped
      .map((q) => `q${q.number} (run ${q.owner_id}, ${q.owner_status})`)
      .join(', ')
    throw new Error(`run ${id} has questions whose owners are not waiting: ${states}`)
  }

  const latest = db()
    .query(
      `SELECT record_id, agent, vendor_session, turn, cwd, worktree, branch, base_commit, worktree_source, executor
     FROM run WHERE record_id = ? OR parent_run_record_id = ?
    ORDER BY turn DESC LIMIT 1`,
    )
    .get(id, id) as {
    record_id: string
    agent: string
    vendor_session: string | null
    turn: number
    cwd: string | null
    worktree: string | null
    branch: string | null
    base_commit: string | null
    worktree_source: 'recipe' | 'git' | 'clone' | 'readonly_recipe' | null
    executor: 'external' | 'harness'
  }
  const sessionFrom = latest.vendor_session
    ? latest
    : (db()
        .query(
          `SELECT record_id, agent, vendor_session, turn
         FROM run WHERE (record_id = ? OR parent_run_record_id = ?) AND vendor_session IS NOT NULL
        ORDER BY turn DESC LIMIT 1`,
        )
        .get(id, id) as {
        record_id: string
        agent: string
        vendor_session: string
        turn: number
      } | null)
  const resumeAgent = sessionFrom?.agent ?? latest.agent

  // The CLI adapter resolves positional, file, and stdin sources before the
  // service boundary. Other adapters supply validated ruling text directly.
  const answers: AnsweredQuestion[] = []
  const argvLimit = ownersLive ? undefined : helpers.argvResumeLimit(resumeAgent)
  const rulingFrom = (text: string): string => {
    if (!text.trim())
      throw new Error(
        `empty ruling: received ${JSON.stringify(text)}\nworking forms:\n${ANSWER_WORKING_FORMS}`,
      )
    const nul = text.indexOf('\0')
    if (nul >= 0)
      throw new Error(
        `ruling contains a NUL at byte offset ${Buffer.byteLength(text.slice(0, nul), 'utf8')}\nworking forms:\n${ANSWER_WORKING_FORMS}`,
      )
    const bytes = Buffer.byteLength(text, 'utf8')
    if (argvLimit !== undefined && bytes > argvLimit)
      throw new Error(
        `ruling is ${bytes} bytes; this agent's resume transport is bounded at ${argvLimit} bytes\nworking forms:\n${ANSWER_WORKING_FORMS}`,
      )
    return text
  }
  if (Array.isArray(input.rulings)) {
    const invalid: string[] = []
    const seen = new Set<string>()
    for (const ruling of input.rulings) {
      if (seen.has(ruling.questionId)) invalid.push(`--q${ruling.questionId} given more than once`)
      seen.add(ruling.questionId)
      if (open.some((q) => q.record_id === ruling.questionId)) continue
      const named = db()
        .query(
          `SELECT q.record_id,q.number,q.answered_at,r.record_id AS run_record_id,
              COALESCE(r.parent_run_record_id, r.record_id) AS root_record_id
         FROM question q JOIN run r ON r.record_id=q.run_record_id WHERE q.record_id=?`,
        )
        .get(ruling.questionId) as {
        record_id: string
        number: number
        answered_at: string | null
        run_record_id: string
        root_record_id: string
      } | null
      if (!named) {
        invalid.push(`--q${ruling.questionId} names no question`)
      } else if (named.root_record_id !== id) {
        invalid.push(wrongQuestionChain(ruling.questionId, named.root_record_id))
      } else if (named.answered_at) {
        invalid.push(`--q${ruling.questionId} on run ${named.run_record_id} is already closed`)
      } else {
        invalid.push(`--q${ruling.questionId} is not open on this chain`)
      }
    }
    if (invalid.length) {
      throw new Error(
        `refusing the whole ruling: ${invalid.join('; ')}\n` +
          `nothing was stored\nworking forms:\n${ANSWER_WORKING_FORMS}`,
      )
    }
    for (const q of open) {
      const ruling = input.rulings.find((item) => item.questionId === q.record_id)
      if (!ruling) continue
      answers.push(answeredQuestion(q, rulingFrom(ruling.text), ruling.fromOperator))
    }
  } else {
    if (!input.rulings) {
      throw new Error(
        `run ${id} is waiting on ${open.length} question(s). ` +
          `Rule with: ${PLATFORM_SLUG} question answer ${id} --q${open[0]!.number} "<ruling>", ` +
          'or pass a ruling via --file or stdin.',
      )
    } else {
      answers.push(answeredQuestion(open[0]!, rulingFrom(input.rulings), input.fromOperator))
    }
  }
  const incomplete = incompleteRulingsRefusal(open.length, answers.length, input, ownersLive)
  if (incomplete) throw new Error(incomplete)

  if (
    answerResumeUnavailable({
      ownersLive,
      skipResume,
      executor: latest.executor,
      vendorSession: sessionFrom?.vendor_session,
      resumable: AGENTS[resumeAgent]?.caps.resumable,
    })
  ) {
    throw new Error(
      `run ${id} cannot be resumed: no vendor session (agent ${resumeAgent}); ` +
        `the ruling was NOT recorded; options: \`${PLATFORM_SLUG} run retry ${id} --agent …\` to ` +
        `re-dispatch with the ruling appended to the spec, or \`${PLATFORM_SLUG} run abandon ${id}\``,
    )
  }
  if (!ownersLive) {
    const assembledLimit = helpers.argvResumeLimit(resumeAgent)
    if (assembledLimit !== undefined) {
      const turnPrompt = rulingPrompt(answers)
      const packed = packedResumePrompt(row.job, turnPrompt, id)
      const assembled = Buffer.byteLength(packed, 'utf8')
      if (assembled > assembledLimit) {
        const shrink = [...answers]
          .map((a) => ({ number: a.number, bytes: Buffer.byteLength(a.answer, 'utf8') }))
          .sort((a, b) => b.bytes - a.bytes || a.number - b.number)
          .map((a) => `--q${a.number} (${a.bytes} bytes)`)
          .join(', ')
        throw new Error(
          `assembled resume prompt is ${assembled} bytes; this agent's resume transport is bounded at ${assembledLimit} bytes\n` +
            `rulings that would need to shrink: ${shrink}\n` +
            `nothing was stored\nworking forms:\n${ANSWER_WORKING_FORMS}`,
        )
      }
    }
  }

  const checkout = continuationCheckoutForAnswer({
    rootId: id,
    skipResume,
    ownersLive,
    requiresRepo: Boolean(job(row.job).needs.readsRepo),
    latestCwd: latest.cwd,
    rootCwd: row.cwd,
    rootRepo: row.repo,
  })
  const now = new Date(Date.now()).toISOString()
  const attributions = answerAttributions(
    authorityDecision.kind,
    input.channel,
    answers,
    callerSession,
  )
  const upd = db().query(
    `UPDATE question
      SET answer=?, answered_at=?, answered_by=?, answered_by_name=?, answerer_kind=?, answer_channel=?, revision=revision+1,
          delivery_pending_at=?, awaiting_operator_at=NULL
    WHERE record_id=?`,
  )
  writeTransaction(() => {
    if (authorityDecision.kind === 'allow-as-owner') {
      answerAuthority = reauthorizeRunMutation(answerAuthority, 'answer')
      answerAuthority = adoptRunMutation(answerAuthority, 'answer')
    }
    answers.forEach((answer, index) => {
      upd.run(
        answer.answer,
        now,
        ...attributions[index]!,
        input.channel,
        ownersLive ? null : now,
        answer.record_id,
      )
      enqueueQuestionRecord(db(), answer.record_id)
    })
    if (skipResume) db().query("UPDATE run SET status='asking' WHERE record_id=?").run(id)
    if (skipResume) {
      appendQuestionDeliveries(
        answers.map((answer) => answer.record_id),
        {
          runId: null,
          mode: QUESTION_DELIVERY_MODE_RECORD_ONLY,
          outcome: QUESTION_DELIVERY_OUTCOME_DELIVERED,
          at: now,
        },
      )
    } else if (ownersLive) {
      for (const answer of answers) {
        const owner = open.find((question) => question.record_id === answer.record_id)!
        appendQuestionDeliveries([answer.record_id], {
          runId: owner.owner_id,
          mode: QUESTION_DELIVERY_MODE_LIVE,
          outcome: QUESTION_DELIVERY_OUTCOME_DELIVERED,
          at: now,
        })
      }
    }
    if (skipResume || ownersLive) auditRunMutation(answerAuthority, 'answer')
  })

  if (skipResume) {
    if (!input.json)
      console.log(
        `recorded ${answers.length} ruling(s) for run ${id}; resume was skipped by --record-only. ` +
          `The run remains asking; use ${PLATFORM_SLUG} run retry ${id} --agent … to re-dispatch with the ruling appended to the spec, ` +
          `or ${PLATFORM_SLUG} run abandon ${id}.`,
      )
    return answerResult('recorded', id, row.number, null)
  }

  if (ownersLive) {
    // Delivered. The worker's own tool call is polling this row and will
    // return with it inside a second; there is nothing else to do, and
    // starting a new turn here would put two workers in one worktree.
    if (!input.json)
      console.log(
        `ruled on ${answers.length} question(s) — the owning turn is still working and will ` +
          `pick this up from its ask_orchestrator call.`,
      )
    return answerResult('delivered-live', id, row.number, null)
  }

  const worktreePath = latest.worktree ?? row.worktree
  /**
   * DETACHED, for the reason `bottega run start` already is.
   *
   * A resumed turn is a full agent run — minutes, not seconds — and run in
   * the foreground it outlives an agent harness's command timeout, which
   * kills the whole process group and takes the worker down with it. That is
   * not hypothetical: it happened on the first multi-turn ruling of real
   * work, and the worker had finished and written its reply when the group
   * was killed. This command was the last place still doing what the canon's
   * own section says loses the work.
   */
  let childId: string
  const resumeWorker = answerResumeWorker(
    latest.executor,
    resumeAgent,
    sessionFrom?.vendor_session ?? '',
  )
  try {
    childId = await (helpers.dispatch ?? detach)(row.job, rulingPrompt(answers), {
      cwd: checkout!.cwd,
      repo: row.repo ?? undefined,
      ...resumeLaunchForRoot(id),
      transport: chainTransport(id) ?? undefined,
      resume: {
        kind: 'continue',
        parent: id,
        agent: resumeWorker.agent,
        session: resumeWorker.session,
        turn: latest.turn + 1,
        sessionId: row.session_id,
        worktree: worktreePath
          ? {
              path: worktreePath,
              branch: latest.branch ?? row.branch ?? '',
              base: latest.base_commit ?? row.base_commit ?? '',
              repoRoot:
                (await import('../git/git-environment.ts')).repoRootOf(worktreePath) ??
                checkout!.project?.path ??
                checkout!.cwd,
              source: latest.worktree_source ?? row.worktree_source ?? undefined,
            }
          : null,
      },
    })
  } catch (e) {
    const error = (e as Error).message
    writeTransaction(() => {
      appendQuestionDeliveries(
        open.map((question) => question.record_id),
        {
          runId: null,
          mode: QUESTION_DELIVERY_MODE_RESUME,
          outcome: QUESTION_DELIVERY_OUTCOME_FAILED,
          at: new Date(Date.now()).toISOString(),
          error,
        },
      )
      for (const q of open) {
        db()
          .query(
            `UPDATE question
            SET answer=NULL, answered_at=NULL, answered_by=NULL, answered_by_name=NULL, answerer_kind=NULL,
                revision=revision+1,
                answer_channel=NULL, delivery_pending_at=NULL, awaiting_operator_at=?
          WHERE record_id=?`,
          )
          .run(q.awaiting_operator_at, q.record_id)
        enqueueQuestionRecord(db(), q.record_id)
      }
    })
    throw new Error(
      `Resume failed: ${error}\nThe ruling was rolled back and the question is still open.`,
    )
  }
  appendQuestionDeliveries(
    open.map((question) => question.record_id),
    {
      runId: childId,
      mode: QUESTION_DELIVERY_MODE_RESUME,
      outcome: QUESTION_DELIVERY_OUTCOME_DELIVERED,
      at: new Date(Date.now()).toISOString(),
    },
  )
  auditRunMutation(answerAuthority, 'answer', null, db(), childId)
  return reportAnswerResume({
    rootId: id,
    rootNumber: row.number,
    childId,
    job: row.job,
    answerCount: answers.length,
    json: input.json,
    flags: input.flags,
    presentation: helpers.presentation,
  })
}
