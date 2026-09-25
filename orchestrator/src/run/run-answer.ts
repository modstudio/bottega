// concern: run-answer
/**
 * Knows questions, chain authority, rulings, retries, and detached resumed
 * turns. Must not know transports, worktrees, routing, reviews, or the CLI.
 */
import { existsSync, readFileSync } from 'node:fs'
import type { AnswerWaitingResult } from '../../../shared/orch-contract.ts'
import { pidAlive } from '../../../shared/process-identity.ts'
import { AGENTS } from '../agent/agent-registry.ts'
import {
  ANSWER_WORKING_FORMS,
  parseAnswerChannelArgs,
  parseAnswerTextSources,
} from '../cli/args.ts'
import { rulingPrompt } from '../contract/contract.ts'
import { dashboardCapabilityAuthorized } from '../dashboard-capability.ts'
import { db, writableDb, writeTransaction } from '../database/db.ts'
import { job } from '../jobs/jobs.ts'
import { mcpRequestFromStored } from '../mcp/mcp-preflight.ts'
import { failureReason } from '../outcome.ts'
import { chainTransport, retryModelForAgent } from '../route/failover.ts'
import { answerRulingRefusal } from '../workflow/autonomy.ts'
import { resolveAnswerRulings } from '../workflow/autonomy-scopes.ts'
import { keepTreeHold } from '../worktree/keep-tree-hold.ts'
import { appendQuestionDeliveries } from './question-delivery.ts'
import {
  answererKindFromAnsweredBy,
  QUESTION_DELIVERY_MODE_LIVE,
  QUESTION_DELIVERY_MODE_RECORD_ONLY,
  QUESTION_DELIVERY_MODE_RESUME,
  QUESTION_DELIVERY_MODE_RETRY,
  QUESTION_DELIVERY_OUTCOME_DELIVERED,
  QUESTION_DELIVERY_OUTCOME_FAILED,
} from './question-vocabulary.ts'
import { packedResumePrompt } from './run.ts'
import { answerAuthorityDecision } from './run-answer-authority.ts'
import { answerRunLivenessRefusal } from './run-answer-liveness.ts'
import { KEEP_RUN_FILES_DAYS, readDispatchState } from './run-artifacts.ts'
import {
  adoptRunMutation,
  auditRunMutation,
  authorizeRunMutation,
  runMutationActor,
} from './run-authority.ts'
import {
  continueRun,
  follow,
  type RunControlPresentation,
  refuseEscapedChain,
  reportContinuedRun,
  resumeLaunchForRoot,
} from './run-control.ts'
import { detach } from './run-dispatch.ts'

type RunAnswerHelpers = {
  argvResumeLimit(agentName: string): number | undefined
  assertWorkerText(text: string, noun: string, workingForms: string, argvLimit?: number): void
  readWorkerFile(path: string): string
  readMessageText(options: {
    missing: string
    exclusive?: string
    sources: { commandFile?: string; positionals: string[] }
  }): Promise<string | undefined>
  presentation: RunControlPresentation
  dispatch?: typeof detach
  dashboardAuthorized?: () => boolean
}
type RunFlags = { detach: boolean; follow: boolean; quiet: boolean }
type OpenQuestion = {
  id: number
  question: string
  awaiting_operator_at: string | null
  owner_id: number
  owner_status: string
  owner_pid: number | null
}

function answeredBy(
  operatorAuthorized: boolean,
  fromOperator: boolean,
  callerSession: string | null,
): string {
  if (operatorAuthorized) return 'operator via hub'
  if (fromOperator) return `operator via ${callerSession ?? 'anonymous (no session id)'}`
  return callerSession ?? 'anonymous (no session id)'
}

function requireAnswerAuthority(
  requestedId: number,
  channel: ReturnType<typeof parseAnswerChannelArgs>['channel'],
  fromOperator: boolean,
  dashboardAuthorized: boolean,
  authority: { owner: string | null; actor: string | null },
) {
  const decision = answerAuthorityDecision({
    channel,
    fromOperator,
    sessionIdPresent: process.env.CLAUDE_CODE_SESSION_ID !== undefined,
    depthPresent: process.env.ORCH_DEPTH !== undefined,
    dashboardAuthorized,
    owner: authority.owner,
    actor: authority.actor,
  })
  if (decision.kind !== 'refuse') return decision
  const refusal = {
    'operator-attribution': '--channel ui requires --from-operator',
    'dashboard-capability': '--channel ui requires the hub dashboard capability',
    'session-marker': `--channel ui is refused when ${decision.actor} is set`,
    'owner-mismatch': `run ${requestedId} is owned by session ${decision.owner}; current session ${decision.actor ?? 'no session identity is present'} cannot answer it`,
  }[decision.code]
  throw new Error(refusal)
}

function readOpenQuestions(id: number, status: string): OpenQuestion[] {
  const open = db()
    .query(
      `SELECT q.id, q.question, q.awaiting_operator_at,
              r.id owner_id, r.status owner_status, r.pid owner_pid
     FROM question q JOIN run r ON r.id = q.run_id
    WHERE (r.id = ? OR r.parent_run_id = ?) AND q.answered_at IS NULL
    ORDER BY q.id`,
    )
    .all(id, id) as OpenQuestion[]
  if (open.length) return open
  const asked = db()
    .query(
      `SELECT COUNT(*) n FROM question q JOIN run r ON r.id = q.run_id
      WHERE r.id = ? OR r.parent_run_id = ?`,
    )
    .get(id, id) as { n: number }
  throw new Error(
    asked.n
      ? `run ${id} has already been ruled on; its current status is ${status}`
      : `run ${id} has no questions to answer; its current status is ${status}`,
  )
}

function requireAnswerableLiveness(
  id: number,
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
      `orch retry ${id} --agent <name> (carries the recorded ruling) or orch abandon ${id}`,
  )
}

function reportUnownedAdoption(
  id: number,
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
  argv: string[],
): Promise<void> {
  if (!project) return
  const rulings = await resolveAnswerRulings(project, launchKey)
  const refusal = answerRulingRefusal(rulings, argv.includes('--from-operator'))
  if (refusal) throw new Error(refusal)
}

function requireAnswerRun<Row>(row: Row | null, requestedId: number): Row {
  if (!row) throw new Error(`no run ${requestedId}`)
  return row
}

export async function retryRun(
  id: number,
  options: { agent?: string; model?: string; flags: RunFlags },
  helpers: RunAnswerHelpers,
): Promise<void> {
  let retryAuthority = authorizeRunMutation(id, 'retry')
  const row = db()
    .query(
      `SELECT id, COALESCE(parent_run_id,id) root_id, agent, job, cwd, prompt_path,
          probe, status, failure_kind, mcp, mcp_error,
          schema_path, model, lens, launch_cwd, launch_seed, launch_key, launch_base, no_failover,
          keep_tree, keep_tree_until, keep_tree_reason, started_at
     FROM run WHERE id = ?`,
    )
    .get(id) as {
    id: number
    root_id: number
    agent: string
    job: string
    cwd: string | null
    prompt_path: string | null
    probe: number
    status: string
    failure_kind: string | null
    mcp: number | null
    mcp_error: string | null
    schema_path: string | null
    model: string | null
    lens: string | null
    launch_cwd: string | null
    launch_seed: string | null
    launch_key: string | null
    launch_base: string | null
    no_failover: number
    keep_tree: number
    keep_tree_until: string | null
    keep_tree_reason: string | null
    started_at: string
  } | null
  if (!row) throw new Error(`no run ${id}`)
  // A writing job already has a worktree and a vendor session. Retry would
  // wrap the prompt again and cut a fresh tree beside the one holding the
  // partial edit. Continue the same conversation in the same tree instead.
  const recordedRulings = db()
    .query(
      `SELECT q.id, q.question, q.answer
     FROM question q JOIN run owner ON owner.id = q.run_id
    WHERE (owner.id = ? OR owner.parent_run_id = ?)
      AND q.delivery_pending_at IS NOT NULL AND q.answer IS NOT NULL
    ORDER BY q.id`,
    )
    .all(row.root_id, row.root_id) as { id: number; question: string; answer: string }[]
  if (job(row.job).needs.writesRepo && !recordedRulings.length) {
    const requested = options.agent
    if (requested && requested !== row.agent) {
      throw new Error(
        `a writing run continues on its own agent (${row.agent}); to start over on ${requested}: ` +
          `orch do ${row.job} --agent ${requested} ...`,
      )
    }
    const resumed = await continueRun(id, undefined, helpers.argvResumeLimit)
    auditRunMutation(retryAuthority, 'retry', `continued as run ${resumed.childId}`)
    await reportContinuedRun(resumed.childId, resumed.job, options.flags, helpers.presentation)
    return
  }
  if (!row.prompt_path || !existsSync(row.prompt_path)) {
    throw new Error(
      `run ${id} has no prompt on disk — it predates prompt capture, or the file has aged out ` +
        `after ${KEEP_RUN_FILES_DAYS} days. Nothing to re-send.`,
    )
  }
  // The SAME agent by default, which is the whole point. A quota limit or a
  // dropped connection is a fact about the moment, not about the agent, and
  // routing around it starts a different agent from scratch on work the first
  // one had already partly done.
  const agent = options.agent ?? row.agent
  if (recordedRulings.length && job(row.job).needs.writesRepo) {
    console.error(
      `— recorded rulings require a fresh worktree; retry will not carry the previous partial edit`,
    )
  }
  console.error(
    `— retrying run ${id} (${row.agent}/${row.job}` +
      (row.failure_kind ? `, ${row.failure_kind}` : '') +
      `) on ${agent}`,
  )
  retryAuthority = writeTransaction(() => adoptRunMutation(retryAuthority, 'retry'))
  // Detached and followed, exactly like `do`. A retry is usually started
  // BECAUSE the first attempt died; running it as a child of this process
  // would leave it dying the same way.
  const originalPrompt = readFileSync(row.prompt_path, 'utf8')
  const retryPrompt = recordedRulings.length
    ? `${originalPrompt}\n\n---\n\n${rulingPrompt(recordedRulings)}`
    : originalPrompt
  const dispatchState = readDispatchState(row.root_id)
  let newId: number
  try {
    newId = await (helpers.dispatch ?? detach)(
      row.job,
      retryPrompt,
      {
        agent,
        schema: row.schema_path ?? undefined,
        mcp: mcpRequestFromStored(row.mcp, row.mcp_error),
        model: retryModelForAgent(row.agent, row.model, agent, options.model),
        lens: row.lens ?? undefined,
        probe: !!row.probe,
        retryOf: id,
        cwd: row.launch_cwd ?? row.cwd ?? undefined,
        seed: row.launch_seed ?? undefined,
        key: row.launch_key ?? undefined,
        base: row.launch_base ?? undefined,
        noFailover: !!row.no_failover,
        transport: chainTransport(row.root_id) ?? undefined,
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
      },
      agent,
    )
  } catch (error) {
    appendQuestionDeliveries(
      recordedRulings.map((ruling) => ruling.id),
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
      recordedRulings.map((ruling) => ruling.id),
      {
        runId: newId,
        mode: QUESTION_DELIVERY_MODE_RETRY,
        outcome: QUESTION_DELIVERY_OUTCOME_DELIVERED,
        at: new Date(Date.now()).toISOString(),
      },
    )
  }
  auditRunMutation(retryAuthority, 'retry', `retried as run ${newId}`)
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
  requestedId: number,
  options: { argv: string[]; recordOnly: boolean; json?: boolean; flags: RunFlags },
  helpers: RunAnswerHelpers,
): Promise<AnswerWaitingResult> {
  const answerArgs = parseAnswerChannelArgs(options.argv)
  const found = db()
    .query(
      `SELECT root.id, root.agent, root.job, root.cwd, root.worktree, root.branch,
          root.base_commit, root.vendor_session, root.status, root.session_id,
          root.turn, root.parent_run_id, root.worktree_source, root.evidence_excluded, root.repo,
          root.launch_key
     FROM run requested
     JOIN run root ON root.id = COALESCE(requested.parent_run_id, requested.id)
    WHERE requested.id = ?`,
    )
    .get(requestedId) as {
    id: number
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
    parent_run_id: number | null
    worktree_source: 'recipe' | 'git' | 'clone' | 'readonly_recipe' | null
    evidence_excluded: string | null
    repo: string | null
    launch_key: string | null
  } | null
  const row = requireAnswerRun(found, requestedId)
  await refuseUserRuling(row.repo, row.launch_key, answerArgs.argv)
  const id = row.id
  refuseEscapedChain(id)
  writableDb()
  let answerAuthority = runMutationActor(requestedId)
  const authorityDecision = requireAnswerAuthority(
    requestedId,
    answerArgs.channel,
    options.argv.includes('--from-operator'),
    (helpers.dashboardAuthorized ?? dashboardCapabilityAuthorized)(),
    answerAuthority,
  )
  if (authorityDecision.kind === 'allow-as-operator') {
    answerAuthority = { ...answerAuthority, actor: authorityDecision.actor }
  }

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
      questions.map((q) => `q${q.id} (run ${q.owner_id}, ${q.owner_status})`).join(', ')
    throw new Error(
      `run ${id} has questions owned by both live and stopped turns. ` +
        `Live: ${list(live)}. Stopped: ${list(stopped)}. Refusing to rule; inspect the run chain.`,
    )
  }
  const ownersLive = live.length > 0
  const recordOnly = options.recordOnly
  const skipResume = recordOnly && !ownersLive
  if (
    !ownersLive &&
    !stopped.every((q) => q.owner_status === 'asking' || q.owner_status === 'running')
  ) {
    const states = stopped.map((q) => `q${q.id} (run ${q.owner_id}, ${q.owner_status})`).join(', ')
    throw new Error(`run ${id} has questions whose owners are not waiting: ${states}`)
  }

  const latest = db()
    .query(
      `SELECT id, agent, vendor_session, turn, cwd, worktree, branch, base_commit, worktree_source
     FROM run WHERE id = ? OR parent_run_id = ?
    ORDER BY turn DESC LIMIT 1`,
    )
    .get(id, id) as {
    id: number
    agent: string
    vendor_session: string | null
    turn: number
    cwd: string | null
    worktree: string | null
    branch: string | null
    base_commit: string | null
    worktree_source: 'recipe' | 'git' | 'clone' | 'readonly_recipe' | null
  }
  const sessionFrom = latest.vendor_session
    ? latest
    : (db()
        .query(
          `SELECT id, agent, vendor_session, turn
         FROM run WHERE (id = ? OR parent_run_id = ?) AND vendor_session IS NOT NULL
        ORDER BY turn DESC LIMIT 1`,
        )
        .get(id, id) as {
        id: number
        agent: string
        vendor_session: string
        turn: number
      } | null)
  const resumeAgent = sessionFrom?.agent ?? latest.agent

  // Two ways to rule: one joined positional / --file / stdin message, or
  // by question id when there are several. `--q<id> --file PATH` binds that
  // file to that question; a command-level `--file` is the single-ruling form.
  const answers: { id: number; question: string; answer: string }[] = []
  const parsed = parseAnswerTextSources(answerArgs.argv)
  const argvLimit = ownersLive ? undefined : helpers.argvResumeLimit(resumeAgent)
  const rulingFrom = (text: string): string => {
    helpers.assertWorkerText(text, 'ruling', ANSWER_WORKING_FORMS, argvLimit)
    return text
  }
  if (parsed.byId.length) {
    if (parsed.commandFile !== undefined || parsed.positionals.length) {
      throw new Error(
        'pass --file next to each --q<id>, not as a command-level flag or positional alongside --q\n' +
          `working forms:\n${ANSWER_WORKING_FORMS}`,
      )
    }
    const invalid: string[] = []
    const seen = new Set<number>()
    for (const src of parsed.byId) {
      if (seen.has(src.id)) invalid.push(`--q${src.id} given more than once`)
      seen.add(src.id)
      if (open.some((q) => q.id === src.id)) continue
      const named = db()
        .query(
          `SELECT q.id, q.answered_at, r.id AS run_id,
              COALESCE(r.parent_run_id, r.id) AS root_id
         FROM question q JOIN run r ON r.id = q.run_id WHERE q.id = ?`,
        )
        .get(src.id) as {
        id: number
        answered_at: string | null
        run_id: number
        root_id: number
      } | null
      if (!named) {
        invalid.push(`--q${src.id} names no question`)
      } else if (named.root_id !== id) {
        invalid.push(`--q${src.id} belongs to run ${named.root_id}, not this chain`)
      } else if (named.answered_at) {
        invalid.push(`--q${src.id} on run ${named.run_id} is already closed`)
      } else {
        invalid.push(`--q${src.id} is not open on this chain`)
      }
    }
    if (invalid.length) {
      throw new Error(
        `refusing the whole ruling: ${invalid.join('; ')}\n` +
          `nothing was stored\nworking forms:\n${ANSWER_WORKING_FORMS}`,
      )
    }
    for (const q of open) {
      const src = parsed.byId.find((item) => item.id === q.id)
      if (!src) continue
      const given = src.file !== undefined ? helpers.readWorkerFile(src.file) : src.text!
      answers.push({ id: q.id, question: q.question, answer: rulingFrom(given) })
    }
  } else {
    const positional = parsed.positionals
    if (parsed.commandFile !== undefined || (!positional.length && !process.stdin.isTTY)) {
      const given = await helpers.readMessageText({
        missing: 'no ruling: pass it as an argument, via --file, or on stdin',
        exclusive: 'pass the ruling either positionally or with --file, not both',
        sources: parsed,
      })
      answers.push({ id: open[0]!.id, question: open[0]!.question, answer: rulingFrom(given!) })
    } else if (!positional.length) {
      throw new Error(
        `run ${id} is waiting on ${open.length} question(s). ` +
          `Rule with: orch answer ${id} --q${open[0]!.id} "<ruling>", ` +
          'or pass a ruling via --file or stdin.',
      )
    } else {
      // One reader: positional words join into one message, never one-per-question.
      answers.push({
        id: open[0]!.id,
        question: open[0]!.question,
        answer: rulingFrom(positional.join(' ')),
      })
    }
  }
  if (answers.length !== open.length) {
    throw new Error(
      `${open.length} question(s) open but ${answers.length} ruling(s) given. ` +
        'For multiple questions, pass every --q<id> in a single command. ' +
        'A worker resumed with a question unanswered will guess, which is the ' +
        'one thing this is here to prevent.',
    )
  }

  if (
    !ownersLive &&
    !skipResume &&
    (!sessionFrom?.vendor_session || AGENTS[resumeAgent]?.caps.resumable === false)
  ) {
    throw new Error(
      `run ${id} cannot be resumed: no vendor session (agent ${resumeAgent}); ` +
        `the ruling was NOT recorded; options: \`orch retry ${id} --agent …\` to ` +
        `re-dispatch with the ruling appended to the spec, or \`orch abandon ${id}\``,
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
          .map((a) => ({ id: a.id, bytes: Buffer.byteLength(a.answer, 'utf8') }))
          .sort((a, b) => b.bytes - a.bytes || a.id - b.id)
          .map((a) => `--q${a.id} (${a.bytes} bytes)`)
          .join(', ')
        throw new Error(
          `assembled resume prompt is ${assembled} bytes; this agent's resume transport is bounded at ${assembledLimit} bytes\n` +
            `rulings that would need to shrink: ${shrink}\n` +
            `nothing was stored\nworking forms:\n${ANSWER_WORKING_FORMS}`,
        )
      }
    }
  }

  const now = new Date(Date.now()).toISOString()
  const upd = db().query(
    `UPDATE question
      SET answer=?, answered_at=?, answered_by=?, answerer_kind=?, answer_channel=?,
          delivery_pending_at=?, awaiting_operator_at=NULL
    WHERE id=?`,
  )
  const answeringIdentity = answeredBy(
    authorityDecision.kind === 'allow-as-operator',
    options.argv.includes('--from-operator'),
    callerSession,
  )
  writeTransaction(() => {
    if (authorityDecision.kind === 'allow-as-owner')
      answerAuthority = adoptRunMutation(answerAuthority, 'answer')
    open.forEach((q, i) => {
      upd.run(
        answers[i]!.answer,
        now,
        answeringIdentity,
        answererKindFromAnsweredBy(answeringIdentity),
        answerArgs.channel,
        ownersLive ? null : now,
        q.id,
      )
    })
    if (skipResume) db().query("UPDATE run SET status='asking' WHERE id=?").run(id)
    if (skipResume) {
      appendQuestionDeliveries(
        open.map((question) => question.id),
        {
          runId: null,
          mode: QUESTION_DELIVERY_MODE_RECORD_ONLY,
          outcome: QUESTION_DELIVERY_OUTCOME_DELIVERED,
          at: now,
        },
      )
    } else if (ownersLive) {
      for (const question of open) {
        appendQuestionDeliveries([question.id], {
          runId: question.owner_id,
          mode: QUESTION_DELIVERY_MODE_LIVE,
          outcome: QUESTION_DELIVERY_OUTCOME_DELIVERED,
          at: now,
        })
      }
    }
    auditRunMutation(answerAuthority, 'answer')
  })

  if (skipResume) {
    if (!options.json)
      console.log(
        `recorded ${answers.length} ruling(s) for run ${id}; resume was skipped by --record-only. ` +
          `The run remains asking; use orch retry ${id} --agent … to re-dispatch with the ruling appended to the spec, ` +
          `or orch abandon ${id}.`,
      )
    return { outcome: 'recorded', run_id: id, resumed_as: null }
  }

  if (ownersLive) {
    // Delivered. The worker's own tool call is polling this row and will
    // return with it inside a second; there is nothing else to do, and
    // starting a new turn here would put two workers in one worktree.
    if (!options.json)
      console.log(
        `ruled on ${answers.length} question(s) — the owning turn is still working and will ` +
          `pick this up from its ask_orchestrator call.`,
      )
    return { outcome: 'delivered-live', run_id: id, resumed_as: null }
  }

  const worktreePath = latest.worktree ?? row.worktree
  /**
   * DETACHED, for the reason `orch do` already is.
   *
   * A resumed turn is a full agent run — minutes, not seconds — and run in
   * the foreground it outlives an agent harness's command timeout, which
   * kills the whole process group and takes the worker down with it. That is
   * not hypothetical: it happened on the first multi-turn ruling of real
   * work, and the worker had finished and written its reply when the group
   * was killed. This command was the last place still doing what the canon's
   * own section says loses the work.
   */
  let childId: number
  try {
    childId = await (helpers.dispatch ?? detach)(row.job, rulingPrompt(answers), {
      cwd: latest.cwd ?? row.cwd ?? process.cwd(),
      ...resumeLaunchForRoot(id),
      transport: chainTransport(id) ?? undefined,
      resume: {
        parent: id,
        agent: resumeAgent,
        session: sessionFrom!.vendor_session!,
        turn: latest.turn + 1,
        sessionId: row.session_id,
        worktree: worktreePath
          ? {
              path: worktreePath,
              branch: latest.branch ?? row.branch ?? '',
              base: latest.base_commit ?? row.base_commit ?? '',
              repoRoot:
                (await import('../git/git-environment.ts')).repoRootOf(worktreePath) ??
                process.cwd(),
              source: latest.worktree_source ?? row.worktree_source ?? undefined,
            }
          : null,
      },
    })
  } catch (e) {
    const error = (e as Error).message
    writeTransaction(() => {
      appendQuestionDeliveries(
        open.map((question) => question.id),
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
            SET answer=NULL, answered_at=NULL, answered_by=NULL, answerer_kind=NULL,
                answer_channel=NULL, delivery_pending_at=NULL, awaiting_operator_at=?
          WHERE id=?`,
          )
          .run(q.awaiting_operator_at, q.id)
      }
    })
    throw new Error(
      `Resume failed: ${error}\nThe ruling was rolled back and the question is still open.`,
    )
  }
  appendQuestionDeliveries(
    open.map((question) => question.id),
    {
      runId: childId,
      mode: QUESTION_DELIVERY_MODE_RESUME,
      outcome: QUESTION_DELIVERY_OUTCOME_DELIVERED,
      at: new Date(Date.now()).toISOString(),
    },
  )
  if (!options.json)
    console.log(`ruled on ${answers.length} question(s); resumed run ${id} as run ${childId}`)
  if (options.flags.detach || !options.flags.follow) {
    if (!options.flags.quiet) {
      console.error(
        `\n— ${row.job} runs detached; a foreground one dies with its shell.` +
          `\n  orch wait ${childId}      then:  orch result ${childId}` +
          `\n  orch inbox          if it stops to ask` +
          `\n  --follow            to watch it here instead`,
      )
    }
    return { outcome: 'resumed', run_id: id, resumed_as: childId }
  }
  const resumedStatus = await follow(childId, options.flags.quiet, false, helpers.presentation)
  if (resumedStatus !== 'ok' && resumedStatus !== 'asking') {
    const failed = db()
      .query(`SELECT status, error, failure_kind, exit_code FROM run WHERE id=?`)
      .get(childId) as {
      status: string
      error: string | null
      failure_kind: string | null
      exit_code: number | null
    }
    throw new Error(
      `the rulings ARE recorded and were not lost, but resumed run ${childId} failed: ` +
        `${failureReason(failed)}\nRetry it with: orch continue ${id}`,
    )
  }
  const done = db().query('SELECT status FROM run WHERE id = ?').get(id) as { status: string }
  console.error(
    done.status === 'asking'
      ? `\n  STILL ASKING — orch inbox`
      : `\n  orch diff ${id}    then score it: ${helpers.presentation.scoreHint(id, row.job, null)}`,
  )
  return { outcome: 'resumed', run_id: id, resumed_as: childId }
}
