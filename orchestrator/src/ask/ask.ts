/**
 * The live escalation channel: a worker asks a question WITHOUT ending its turn.
 *
 * The durable protocol already works — a worker returns `status: blocked`, the
 * architect rules, and `orch answer` resumes its session. That is the right
 * fallback and it is what everything degrades to. But it is coarse: the worker
 * stops, its turn ends, and it comes back through a resume. For a question that
 * takes the architect ten seconds to answer, ending a turn to ask it is a lot
 * of ceremony, and a worker facing three small ambiguities will batch them or —
 * worse — decide two of them itself to avoid the round trip.
 *
 * So this is the finer-grained half: one MCP tool the worker calls mid-task,
 * which blocks until a ruling lands and then returns it. The worker never loses
 * its turn, never re-reads anything, and asking becomes as cheap as any other
 * tool call — which is the only way asking beats guessing in practice rather
 * than on paper.
 *
 * WHY A WHOLE MCP SERVER AND NOT A SENTINEL IN THE OUTPUT. A sentinel the
 * wrapper greps for can only be noticed once the process has finished writing,
 * which is exactly the thing being avoided. The agents already speak MCP, all
 * of this machine's servers are plain stdio, and a tool call is the one
 * mechanism that can block a running agent and hand it a value back.
 *
 * IT ALWAYS ANSWERS. A tool that can hang for ever would be worse than no tool:
 * the worker would sit holding a subscription seat with nothing to wait for,
 * and the run's own timeout would eventually kill work that was finished except
 * for one question. On a timeout it returns an instruction to stop and report
 * the question in the final answer — which is precisely the durable protocol,
 * so the fast path degrades into the slow one rather than into a hang.
 */

import { createConnection, createServer, type Socket } from 'node:net'
import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'
import {
  BOARD_ASK_REFRESH_BUDGET_MS,
  claimRunBoardNotices,
  markRunBoardNoticesDelivered,
} from '../board/board-delivery.ts'
import { db, nowIso, writableDb, writeTransaction } from '../database/db.ts'
import { appendRunEvent } from '../events.ts'
import {
  decideGateCancellation,
  decideGateEligibility,
  decideGateRequest,
  decideGateWait,
  formatGateRequestDecision,
  formatGateResult,
  RUN_GATE_WAIT_MS,
  shapeGateResult,
} from '../gate/gate-decision.ts'
import { formatRecordedGateResult, recordedGateResult } from '../gate/gate-result.ts'
import { JOBS } from '../jobs/jobs.ts'
import { checkMessages, messageArchitect } from '../mailbox/mailbox.ts'
import { initialQuestionWaitingAt } from '../operator/operator-waiting.ts'
import { machineId } from '../record/machine-identity.ts'
import { enqueueQuestionRecord } from '../run/question-outbox.ts'
import { ASKED_VIA_LIVE, ASKED_VIA_REPLY, type AskedVia } from '../run/question-vocabulary.ts'
import { runScratchDir } from '../run/run-artifacts.ts'
import { enqueueRunRecord } from '../run/run-outbox.ts'
import { registerAskBoardTools } from './ask-board-tools.ts'
import { type AskLifecycle, askLifecycle, observeAskTransport } from './ask-lifecycle.ts'
import { authenticatedWorkerRun } from './worker-auth.ts'
import { validateWorkerNoteInput, type WorkerNoteInput, type WorkerNoteRun } from './worker-note.ts'
import { requestWorkerNote } from './worker-note-request.ts'

/**
 * How long a worker waits for a ruling before falling back.
 *
 * Ten minutes is chosen against the architect's rhythm rather than the
 * worker's: Claude is usually mid-turn on something else when a question
 * arrives, and a bound short enough to be tidy would expire during a single
 * long tool call. It sits comfortably inside every agent's own `timeoutMs`
 * (codex 20m, grok 25m), because a wait that outlived the run would convert a
 * question into a killed process.
 */
function boundedTimeout(): number {
  const raw = Number(process.env.ORCH_ASK_TIMEOUT_MS ?? 10 * 60_000)
  // A non-finite or nonsense value would make the deadline unreachable, and an
  // unreachable deadline is precisely the hang this whole file exists to
  // prevent — `ORCH_ASK_TIMEOUT_MS=Infinity` would restore it in one word.
  return Number.isFinite(raw) && raw > 0 ? raw : 10 * 60_000
}
const ASK_TIMEOUT_MS = boundedTimeout()

function recordQuestion(input: {
  runId: number
  askedAt: string
  question: string
  options?: string[] | null
  recommendation?: string | null
  why?: string | null
  askedVia: AskedVia
  awaitingOperatorAt: string | null
}): number {
  const inserted = db()
    .query(
      `INSERT INTO question
       (run_id, asked_at, question, options, recommendation, why, asked_via, awaiting_operator_at)
       VALUES (?,?,?,?,?,?,?,?) RETURNING id`,
    )
    .get(
      input.runId,
      input.askedAt,
      input.question,
      input.options?.length ? JSON.stringify(input.options) : null,
      input.recommendation ?? null,
      input.why ?? null,
      input.askedVia,
      input.awaitingOperatorAt,
    ) as { id: number }
  enqueueQuestionRecord(db(), inserted.id)
  return inserted.id
}

export function recordReplyQuestions(input: {
  runId: number
  questions: Array<{
    question: string
    options?: string[] | null
    recommendation?: string | null
    why?: string | null
  }>
  askedAt: string
  awaitingOperatorAt: string | null
}): void {
  writeTransaction(() => {
    enqueueRunRecord(db(), input.runId, machineId(), input.askedAt)
    for (const question of input.questions) {
      recordQuestion({
        runId: input.runId,
        askedAt: input.askedAt,
        ...question,
        askedVia: ASKED_VIA_REPLY,
        awaitingOperatorAt: input.awaitingOperatorAt,
      })
    }
  })
}

/** How often to look for a ruling. Cheap: one indexed read of a local file. */
const POLL_MS = 1_000

export type AskResult = { answered: true; answer: string } | { answered: false; reason: string }

function gateEligibility(runId: number, token: string) {
  const row = db()
    .query(
      `SELECT r.job,p.settings FROM run r
       LEFT JOIN project p ON p.id=r.project_id WHERE r.id=?`,
    )
    .get(runId) as { job: string; settings: string | null } | null
  let gate: string | null = null
  try {
    const settings = JSON.parse(row?.settings ?? '{}') as { gate?: unknown }
    gate = typeof settings.gate === 'string' ? settings.gate : null
  } catch {
    gate = null
  }
  return decideGateEligibility({
    authenticated: authenticatedWorkerRun(runId, token),
    writer: Boolean(row && JOBS[row.job]?.needs.writesRepo),
    gate,
  })
}

function gateToolAvailable(runId: number, token: string): boolean {
  if (!authenticatedWorkerRun(runId, token)) return false
  const row = db().query('SELECT job FROM run WHERE id=?').get(runId) as { job: string } | null
  return Boolean(row && JOBS[row.job]?.needs.writesRepo)
}

function gateResultToolAvailable(runId: number, token: string): boolean {
  if (!authenticatedWorkerRun(runId, token)) return false
  const row = db().query('SELECT job FROM run WHERE id=?').get(runId) as { job: string } | null
  const needs = row ? JOBS[row.job]?.needs : null
  return Boolean(needs?.readsRepo && !needs.writesRepo)
}

type GateWaitDependencies = {
  waitMs: number
  now(): number
  wait(ms: number): Promise<void>
}

const defaultGateWaitDependencies: GateWaitDependencies = {
  waitMs: RUN_GATE_WAIT_MS,
  now: Date.now,
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

type GateExecutionSelection = {
  id: number
  requested_at: string
  finished_at: string | null
}

function latestGateExecution(runId: number): GateExecutionSelection | null {
  return db()
    .query(
      `SELECT id,requested_at,finished_at FROM gate_execution
        WHERE run_id=? ORDER BY id DESC LIMIT 1`,
    )
    .get(runId) as GateExecutionSelection | null
}

type RequestedGate =
  | { id: number; requestedAt: string; introduction: string | null }
  | { message: string }

function selectGateExecutionOnce(
  runId: number,
  pendingResults: ReadonlySet<number>,
): RequestedGate {
  return writeTransaction(() => {
    const run = db().query('SELECT status,gate_requests_closed FROM run WHERE id=?').get(runId) as {
      status: string
      gate_requests_closed: number
    } | null
    const cancellation = decideGateCancellation({
      requestsClosed: run?.gate_requests_closed === 1,
      runLive: run?.status === 'running' || run?.status === 'asking',
    })
    if (cancellation) return { message: cancellation }
    const latest = latestGateExecution(runId)
    const decision = decideGateRequest({
      execution: latest ? { id: latest.id, finished: latest.finished_at !== null } : null,
      resultPending: latest ? pendingResults.has(latest.id) : false,
    })
    if (decision.action !== 'start') {
      return {
        id: decision.executionId,
        requestedAt: latest!.requested_at,
        introduction: formatGateRequestDecision(decision),
      }
    }
    const requestedAt = nowIso()
    const inserted = db()
      .query('INSERT INTO gate_execution (run_id,requested_at) VALUES (?,?) RETURNING id')
      .get(runId, requestedAt) as { id: number }
    return { id: inserted.id, requestedAt, introduction: null }
  })
}

function selectGateExecution(runId: number, pendingResults: ReadonlySet<number>): RequestedGate {
  try {
    return selectGateExecutionOnce(runId, pendingResults)
  } catch (error) {
    if (!String(error).includes('UNIQUE constraint failed')) throw error
    return selectGateExecutionOnce(runId, pendingResults)
  }
}

function waitForGatePoll(ms: number, signal: AbortSignal, wait: (ms: number) => Promise<void>) {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const aborted = () => finish(resolve)
    const finish = (settle: () => void) => {
      signal.removeEventListener('abort', aborted)
      settle()
    }
    signal.addEventListener('abort', aborted, { once: true })
    wait(ms).then(
      () => finish(resolve),
      (error) => finish(() => reject(error)),
    )
  })
}

async function waitForGateExecution(
  runId: number,
  requested: Exclude<RequestedGate, { message: string }>,
  pendingResults: Set<number>,
  dependencies: GateWaitDependencies,
  signal: AbortSignal,
): Promise<string> {
  const id = requested.id
  pendingResults.add(id)
  const waitStartedAt = dependencies.now()
  // A caller that disappears without sending cancellation can still consume a later result.
  for (;;) {
    if (signal.aborted) return 'The gate wait stopped because the run_gate call was cancelled.'
    const row = db()
      .query(
        `SELECT g.exit_code,g.timed_out,g.elapsed_ms,g.output_tail,g.output_artifact,
                g.cancelled_reason,r.status,r.gate_requests_closed
         FROM gate_execution g JOIN run r ON r.id=g.run_id WHERE g.id=?`,
      )
      .get(id) as {
      exit_code: number | null
      timed_out: number | null
      elapsed_ms: number | null
      output_tail: string | null
      output_artifact: string | null
      cancelled_reason: string | null
      status: string
      gate_requests_closed: number
    } | null
    if (!row) return 'Gate run cancelled because its execution record is no longer available.'
    const cancellation =
      row.cancelled_reason ??
      decideGateCancellation({
        requestsClosed: row.gate_requests_closed === 1,
        runLive: row.status === 'running' || row.status === 'asking',
      })
    if (cancellation) return cancellation
    const finished = row.exit_code !== null && row.timed_out !== null && row.elapsed_ms !== null
    const now = dependencies.now()
    const waitDecision = decideGateWait({
      finished,
      waitElapsedMs: now - waitStartedAt,
      executionElapsedMs: Math.max(0, now - Date.parse(requested.requestedAt)),
      waitMs: dependencies.waitMs,
    })
    if (finished) {
      pendingResults.delete(id)
      const result = formatGateResult(
        shapeGateResult({
          exitCode: row.exit_code!,
          timedOut: row.timed_out === 1,
          elapsedMs: row.elapsed_ms!,
          output: row.output_tail ?? '',
          outputPath: `${runScratchDir(runId)}/gate-${id}.log`,
          artifactPath: row.output_artifact ?? '(no artifact recorded)',
        }),
      )
      return requested.introduction ? `${requested.introduction}\n${result}` : result
    }
    if (!waitDecision.wait) return waitDecision.message!
    await waitForGatePoll(
      Math.min(POLL_MS, dependencies.waitMs - (now - waitStartedAt)),
      signal,
      dependencies.wait,
    )
  }
}

async function requestGate(
  runId: number,
  pendingResults: Set<number>,
  signal: AbortSignal,
  dependencies: GateWaitDependencies = defaultGateWaitDependencies,
): Promise<string> {
  writableDb()
  const requested = selectGateExecution(runId, pendingResults)
  if ('message' in requested) return requested.message
  return waitForGateExecution(runId, requested, pendingResults, dependencies, signal)
}

/**
 * Record a question and wait for the architect to rule on it.
 *
 * The row is written before the wait so the question is visible in `orch inbox`
 * immediately — a worker blocked on a question nobody can see is the failure
 * this whole channel exists to remove, and it would look exactly like a hung
 * agent.
 */
export async function ask(o: {
  runId: number
  question: string
  options?: string[]
  recommendation?: string
  why?: string
  timeoutMs?: number
}): Promise<AskResult> {
  writableDb()
  const askedAt = nowIso()
  const awaitingOperatorAt = await initialQuestionWaitingAt(o.runId, askedAt)
  const id = writeTransaction(() => {
    db().query("UPDATE run SET status='asking' WHERE id=? AND status='running'").run(o.runId)
    enqueueRunRecord(db(), o.runId, machineId(), askedAt)
    return recordQuestion({
      runId: o.runId,
      askedAt,
      question: o.question,
      options: o.options,
      recommendation: o.recommendation,
      why: o.why,
      askedVia: ASKED_VIA_LIVE,
      awaitingOperatorAt,
    })
  })
  const deadline = Date.now() + (o.timeoutMs ?? ASK_TIMEOUT_MS)
  const q = db().query('SELECT answer FROM question WHERE id = ? AND answered_at IS NOT NULL')

  // BOUNDED BY CONSTRUCTION, like `orch wait`. An unbounded poll against a
  // question nobody will ever answer is the failure this is meant to remove
  // rather than relocate.
  for (;;) {
    const row = q.get(id) as { answer: string | null } | null
    if (row) {
      db().query("UPDATE run SET status='running' WHERE id=? AND status='asking'").run(o.runId)
      appendRunEvent(o.runId, {
        ts: nowIso(),
        type: 'text',
        text: 'ruling delivered; worker resumed',
      })
      return { answered: true, answer: row.answer ?? '' }
    }
    if (Date.now() >= deadline) {
      // The question STAYS OPEN. The architect may still want to see what was
      // asked, and the worker is about to report it in its final answer
      // anyway — withdrawing it here would lose the record of a decision that
      // still has to be made.
      return {
        answered: false,
        reason:
          'No ruling arrived within the time limit. The architect is not available right now. ' +
          'Do NOT decide this yourself. Stop here and return status "blocked" with this ' +
          'question in your final answer, describing what you completed before reaching it.',
      }
    }
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}

/**
 * The run id comes from the ENVIRONMENT, not from the tool arguments. A worker
 * that had to name its own run could name someone else's, and in a fan-out that
 * is not hypothetical — several workers are alive at once and each one's idea
 * of "my run id" would be a guess. `ORCH_RUN_ID` is set by the process that
 * spawned the agent, which is the only party that actually knows.
 */
type AskServerDependencies = {
  fileWorkerNote(
    run: WorkerNoteRun,
    input: WorkerNoteInput,
  ): Promise<{
    noteId: number
    candidateIds: number[]
    anchorDropped?: string
  }>
  gate?: GateWaitDependencies
  lifecycle?: AskLifecycle
}

function workerNoteRun(runId: number): WorkerNoteRun {
  const row = db()
    .query(
      `SELECT r.id,p.name AS project,p.path AS project_path,
              COALESCE(r.worktree,r.cwd) AS tree,r.branch,
              r.session_id,r.head_commit
         FROM run r JOIN project p ON p.id=r.project_id WHERE r.id=?`,
    )
    .get(runId) as {
    id: number
    project: string
    project_path: string
    tree: string | null
    branch: string | null
    session_id: string | null
    head_commit: string | null
  } | null
  if (!row) throw new Error(`run ${runId} has no registered project`)
  if (!row.tree) throw new Error(`run ${runId} has no run tree for a file-bound observation`)
  return {
    id: row.id,
    project: row.project,
    projectPath: row.project_path,
    tree: row.tree,
    branch: row.branch,
    sessionId: row.session_id,
    headCommit: row.head_commit,
  }
}

export function createAskMcpServer(
  runId: number,
  token: string,
  timeoutMs?: number,
  dependencies: AskServerDependencies = { fileWorkerNote: requestWorkerNote },
): McpServer {
  /**
   * WHETHER THIS PROCESS IS ACTUALLY THE WORKER IT CLAIMS TO BE.
   *
   * The server is registered globally with codex and grok, so ANY process on
   * this machine can launch it with `ORCH_RUN_ID=42` and post questions that
   * appear to come from run 42 — polluting its inbox and, worse, letting an
   * architect's ruling be shaped by a question the real worker never asked.
   * A run id is an identifier, not a credential, and it is printed in every
   * listing.
   *
   * So a per-run secret is minted alongside the row and handed to the child in
   * its environment, which is the one place an unrelated process cannot read
   * from. The check is deliberately cheap and deliberately not clever: it
   * bounds an accident and a casual misuse, not a determined local attacker,
   * who can read the environment of a process they already own.
   */
  const authorized = (): boolean => authenticatedWorkerRun(runId, token)
  const pendingGateResults = new Set<number>()
  const lifecycle = dependencies.lifecycle ?? askLifecycle(runId)
  const toolNames = ['suggest_board_post']

  const server = new McpServer({ name: 'orch-ask', version: '1' })
  const text = (value: string, isError?: true) => ({
    content: [{ type: 'text' as const, text: value }],
    ...(isError ? { isError } : {}),
  })
  const missing = (field: 'question' | 'body') =>
    text(
      `No ${field} was supplied. Call ${field === 'question' ? 'ask_orchestrator' : 'message_orchestrator'} again with the ${field} in the \`${field}\` field. Do not decide the matter yourself.`,
    )
  const unauthorized = () =>
    'This process is not a recognized orchestrator worker. Return status "blocked" with your question in the final answer.'

  // Preprocessing keeps the wire schema honest (`question` and `body` remain
  // required) while ensuring an omitted value reaches the handler. Otherwise
  // the SDK returns a validation error before the escalation channel can tell
  // the worker to ask again rather than decide the matter itself.
  const requiredTextReachingHandler = z.preprocess((value) => String(value ?? ''), z.string())

  registerAskBoardTools({ server, runId, authorized, unauthorized, text })

  toolNames.push('ask_orchestrator')
  server.registerTool(
    'ask_orchestrator',
    {
      description:
        'Ask the architect to rule on a design decision that is not yours to make. ' +
        'Blocks until they answer. Use this the moment you are unsure: asking is free ' +
        'and expected, guessing is not. Ask everything you need in one call where you can.',
      inputSchema: z.object({
        question: requiredTextReachingHandler.describe('The decision you need made.'),
        options: z
          .preprocess(
            (value) => (Array.isArray(value) ? value.map(String) : undefined),
            z.array(z.string()).optional(),
          )
          .describe('The choices as you see them.'),
        recommendation: z
          .preprocess((value) => (value ? String(value) : undefined), z.string().optional())
          .describe('What you would do, and why.'),
        why: z
          .preprocess((value) => (value ? String(value) : undefined), z.string().optional())
          .describe('What this changes about the implementation.'),
      }),
    },
    async ({ question, options, recommendation, why }) => {
      if (!question.trim()) return missing('question')
      try {
        const result = authorized()
          ? await ask({ runId, question, options, recommendation, why, timeoutMs })
          : { answered: false as const, reason: unauthorized() }
        return text(result.answered ? result.answer : result.reason)
        // Not `isError`. A timeout is a legitimate outcome carrying an
        // instruction the worker must follow; flagged as an error, agents
        // retry it or treat the tool as broken and stop using it.
      } catch (error) {
        // EVERY PATH ANSWERS. Without this, a failed insert — a foreign key
        // against a run that has been deleted, a locked database — throws
        // inside the SDK's detached request promise. An SDK handler that throws
        // returns `isError`, so this deliberate ordinary reply also preserves
        // the escalation channel's instruction instead of inviting a retry.
        return text(
          `The orchestrator could not record this question (${String(error)}). ` +
            'Do not decide it yourself: return status "blocked" with the question ' +
            'in your final answer.',
        )
      }
    },
  )

  // A no-gate writer sees the tool and receives the explicit no-op message.
  // Readers and inline jobs do not receive an execution surface at all.
  if (gateToolAvailable(runId, token)) {
    toolNames.push('run_gate')
    server.registerTool(
      'run_gate',
      {
        description:
          "Run this project's registered gate in the run worktree through the supervising orchestrator. " +
          'The command, directory, and environment are fixed by orch and take no worker input.',
        inputSchema: z.object({}),
      },
      async (_arguments, context) => {
        try {
          const eligibility = gateEligibility(runId, token)
          if (!eligibility.eligible) return text(eligibility.message)
          return text(
            await requestGate(runId, pendingGateResults, context.mcpReq.signal, dependencies.gate),
          )
        } catch (error) {
          return text(`The registered gate could not be run (${String(error)}).`, true)
        }
      },
    )
  }

  if (gateResultToolAvailable(runId, token)) {
    toolNames.push('gate_result')
    server.registerTool(
      'gate_result',
      {
        description:
          'Read the most recent recorded gate result for the exact project commit under review. ' +
          'This runs nothing and takes no input.',
        annotations: { readOnlyHint: true },
      },
      async () => {
        try {
          return text(formatRecordedGateResult(recordedGateResult(runId)))
        } catch (error) {
          return text(`The recorded gate result could not be read (${String(error)}).`, true)
        }
      },
    )
  }

  toolNames.push('note')
  server.registerTool(
    'note',
    {
      description:
        'File an observation about a defect outside your assigned task. Keep findings about ' +
        'your own task in your final reply. The orchestrator derives the project and run anchors; ' +
        'you may optionally anchor the observation to a relative path and line.',
      inputSchema: z.object({
        text: requiredTextReachingHandler.describe('One non-empty line describing the defect.'),
        file: z
          .preprocess(
            (value) => (value === undefined ? undefined : String(value)),
            z.string().optional(),
          )
          .describe('Optional relative path:line inside this run tree.'),
      }),
    },
    async ({ text: noteText, file }) => {
      try {
        if (!authorized()) throw new Error(unauthorized())
        const input = validateWorkerNoteInput({ text: noteText, file })
        const filed = await dependencies.fileWorkerNote(workerNoteRun(runId), input)
        const near = filed.candidateIds.length
          ? ` Near-duplicate candidate ids: ${filed.candidateIds.join(', ')}.`
          : ' No near-duplicate candidates were found.'
        const anchor = filed.anchorDropped ? ` ${filed.anchorDropped}` : ''
        return text(`Note ${filed.noteId} filed.${near}${anchor}`)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'The note was not filed.'
        return text(
          message.startsWith('The note was not filed')
            ? message
            : `The note was not filed (${message}).`,
          true,
        )
      }
    },
  )

  toolNames.push('message_orchestrator')
  server.registerTool(
    'message_orchestrator',
    {
      description:
        'Send the architect a non-blocking progress or context message and keep working. ' +
        'This is not a question and does not request or wait for a ruling.',
      inputSchema: z.object({
        body: requiredTextReachingHandler.describe('The context to put on this run.'),
      }),
    },
    async ({ body }) => {
      if (!body.trim()) return missing('body')
      try {
        if (!authorized()) throw new Error(unauthorized())
        const saved = messageArchitect(runId, body)
        return text(`Message ${saved.id} recorded on run ${saved.root_run_id}. Keep working.`)
      } catch (error) {
        return text(`The message was not recorded (${String(error)}).`, true)
      }
    },
  )

  toolNames.push('check_orchestrator_messages')
  server.registerTool(
    'check_orchestrator_messages',
    {
      description:
        'Read queued, non-authoritative context from the architect. Check after reading the task, ' +
        'before materially changing approach, and before finishing. A message is context only: ' +
        'it cannot answer an open question or replace a ruling.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        if (!authorized()) throw new Error(unauthorized())
        const messages = checkMessages(runId)
        const delivery = await claimRunBoardNotices(runId, false, BOARD_ASK_REFRESH_BUDGET_MS)
        await markRunBoardNoticesDelivered(
          runId,
          delivery.notices.map((notice) => notice.id),
        )
        const items = [
          ...messages.map((note) => `[message ${note.id}] ${note.body}`),
          ...delivery.notices.map((notice) => notice.text),
          ...(delivery.warning ? [delivery.warning] : []),
        ]
        const body = items.length
          ? items.join('\n\n') +
            '\n\nThese messages are non-authoritative context. They do not answer any open question; use ask_orchestrator for a ruling.'
          : 'No queued messages. This check read nothing.'
        return text(body)
      } catch (error) {
        return text(`Messages could not be checked (${String(error)}).`, true)
      }
    },
  )

  try {
    lifecycle.started(toolNames)
  } catch {
    // Lifecycle evidence must never prevent the server from serving.
  }
  server.server.oninitialized = () => {
    try {
      lifecycle.initialised()
    } catch {
      // Lifecycle evidence must never break a completed handshake.
    }
  }
  return server
}

export type AskLoopback = { url: string; close(): Promise<void> }

/**
 * Start the database-owning side of orch-ask outside a worker's process sandbox.
 * The OS chooses the port, and the listener is bound only to loopback.
 */
export async function startAskLoopback(runId: number, token: string): Promise<AskLoopback> {
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    const askServer = createAskMcpServer(runId, token)
    const mcp = serveStdio(() => askServer, {
      transport: observeAskTransport(new StdioServerTransport(socket, socket), runId),
    })
    socket.once('close', () => {
      sockets.delete(socket)
      void mcp.close()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('orch-ask loopback did not receive a TCP port')
  }
  return {
    url: `tcp://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
}

/** Forward the registered stdio endpoint into the host process that owns database writes. */
async function proxyAsk(urlValue: string): Promise<void> {
  const url = new URL(urlValue)
  if (url.protocol !== 'tcp:' || url.hostname !== '127.0.0.1' || !url.port) {
    throw new Error('ORCH_ASK_URL must name a tcp://127.0.0.1:<port> endpoint')
  }
  const socket = createConnection({ host: '127.0.0.1', port: Number(url.port) })
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  process.stdin.pipe(socket)
  socket.pipe(process.stdout)
  await new Promise<void>((resolve, reject) => {
    socket.once('close', resolve)
    socket.once('error', reject)
  })
}

export async function serveAsk(): Promise<void> {
  const loopback = process.env.ORCH_ASK_URL
  if (loopback) return proxyAsk(loopback)
  const runId = Number(process.env.ORCH_RUN_ID ?? 0)
  const token = process.env.ORCH_RUN_TOKEN ?? ''
  serveStdio(() => createAskMcpServer(runId, token), {
    transport: observeAskTransport(new StdioServerTransport(), runId),
  })
}
