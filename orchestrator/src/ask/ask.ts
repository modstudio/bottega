/**
 * The live escalation channel: a worker asks a question WITHOUT ending its turn.
 *
 * The durable protocol already works — a worker returns `status: blocked`, the
 * architect rules, and `bottega question answer` resumes its session. That is the right
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

import type { Database } from 'bun:sqlite'
import { createConnection, createServer, type Socket } from 'node:net'
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server'
import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'
import { WORKER_MCP_SERVER_NAME } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  BOARD_ASK_REFRESH_BUDGET_MS,
  claimRunBoardNotices,
  markRunBoardNoticesDelivered,
} from '../board/board-delivery.ts'
import {
  db,
  declareStoreBrokerChannel,
  nowIso,
  writableDb,
  writeTransaction,
} from '../database/db.ts'
import { appendRunEvent } from '../events.ts'
import { registerFocusedTestTool } from '../focused-test/focused-test-tool.ts'
import {
  decideGateCancellation,
  decideGateRequest,
  decideGateWait,
  decideWorkerCheckEligibility,
  formatGateRequestDecision,
  formatGateResult,
  RUN_GATE_WAIT_MS,
  shapeGateResult,
} from '../gate/gate-decision.ts'
import { formatRecordedGateResult, recordedGateResult } from '../gate/gate-result.ts'
import { requestGateExecution } from '../gate/gate-run.ts'
import { JOBS } from '../jobs/jobs.ts'
import { LOCAL_LISTENER_IDLE_TIMEOUT_SECONDS } from '../local-listener.ts'
import { checkMessages, messageArchitect } from '../mailbox/mailbox.ts'
import { initialQuestionWaitingAt } from '../operator/operator-waiting.ts'
import { machineId } from '../record/machine-identity.ts'
import { nextQuestionNumber } from '../run/question-number.ts'
import { enqueueQuestionRecord } from '../run/question-outbox.ts'
import { ASKED_VIA_LIVE, ASKED_VIA_REPLY, type AskedVia } from '../run/question-vocabulary.ts'
import { runScratchDir } from '../run/run-artifacts.ts'
import { resolveRunIdentifier } from '../run/run-identifier.ts'
import { enqueueRunRecord } from '../run/run-outbox.ts'
import { enableRunSchemaReload } from '../run/run-schema-reload-cause.ts'
import { registerAskBoardTools } from './ask-board-tools.ts'
import { writeAskServerFailure } from './ask-failure.ts'
import { type AskLifecycle, askLifecycle, observeAskTransport } from './ask-lifecycle.ts'
import { authenticatedWorkerRun } from './worker-auth.ts'
import {
  validateWorkerNoteInput,
  type WorkerNoteFiledResult,
  type WorkerNoteInput,
  type WorkerNoteRun,
} from './worker-note.ts'
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
  const raw = Number(process.env.BOTTEGA_ASK_TIMEOUT_MS ?? 10 * 60_000)
  // A non-finite or nonsense value would make the deadline unreachable, and an
  // unreachable deadline is precisely the hang this whole file exists to
  // prevent — `BOTTEGA_ASK_TIMEOUT_MS=Infinity` would restore it in one word.
  return Number.isFinite(raw) && raw > 0 ? raw : 10 * 60_000
}
const ASK_TIMEOUT_MS = boundedTimeout()

function recordQuestion(input: {
  runId: string
  askedAt: string
  question: string
  options?: string[] | null
  recommendation?: string | null
  why?: string | null
  askedVia: AskedVia
  awaitingOperatorAt: string | null
}): string {
  const recordId = newRecordId()
  const inserted = db()
    .query<{ record_id: string }, (string | number | null)[]>(
      `INSERT INTO question
       (record_id,number,run_record_id,asked_at,question,options,recommendation,why,asked_via,awaiting_operator_at)
       VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING record_id`,
    )
    .get(
      recordId,
      nextQuestionNumber(db()),
      input.runId,
      input.askedAt,
      input.question,
      input.options?.length ? JSON.stringify(input.options) : null,
      input.recommendation ?? null,
      input.why ?? null,
      input.askedVia,
      input.awaitingOperatorAt,
    )
  if (!inserted) throw new Error('question was not recorded')
  enqueueQuestionRecord(db(), inserted.record_id)
  return inserted.record_id
}

export function recordReplyQuestions(input: {
  runId: string
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

function checkEligibility(runId: string, token: string) {
  const row = db()
    .query(
      `SELECT r.job,p.settings FROM run r
       LEFT JOIN project p ON p.record_id=r.project_record_id WHERE r.record_id=?`,
    )
    .get(runId) as { job: string; settings: string | null } | null
  let workerCheck: string | null = null
  try {
    const settings = JSON.parse(row?.settings ?? '{}') as { workerCheck?: unknown }
    workerCheck = typeof settings.workerCheck === 'string' ? settings.workerCheck : null
  } catch {
    workerCheck = null
  }
  return decideWorkerCheckEligibility({
    authenticated: authenticatedWorkerRun(runId, token),
    writer: Boolean(row && JOBS[row.job]?.needs.writesRepo),
    workerCheck,
  })
}

function authenticatedJobNeeds(runId: string, token: string) {
  if (!authenticatedWorkerRun(runId, token)) return null
  const row = db().query('SELECT job FROM run WHERE record_id=?').get(runId) as {
    job: string
  } | null
  return row ? JOBS[row.job]?.needs : null
}

function checkToolAvailable(runId: string, token: string): boolean {
  return checkEligibility(runId, token).eligible
}
function focusedTestToolAvailable(runId: string, token: string): boolean {
  return Boolean(authenticatedJobNeeds(runId, token)?.writesRepo)
}
function gateResultToolAvailable(runId: string, token: string): boolean {
  const needs = authenticatedJobNeeds(runId, token)
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
  record_id: string
  number: number
  requested_at: string
  finished_at: string | null
}

function latestGateExecution(runId: string): GateExecutionSelection | null {
  return db()
    .query(
      `SELECT record_id,number,requested_at,finished_at FROM gate_execution
        WHERE run_record_id=? AND purpose='worker-check'
        ORDER BY requested_at DESC,record_id DESC LIMIT 1`,
    )
    .get(runId) as GateExecutionSelection | null
}

type RequestedGate =
  | { recordId: string; number: number; requestedAt: string; introduction: string | null }
  | { message: string }

function selectGateExecutionOnce(
  runId: string,
  pendingResults: ReadonlySet<string>,
): RequestedGate {
  return writeTransaction(() => {
    const run = db()
      .query('SELECT status,gate_requests_closed FROM run WHERE record_id=?')
      .get(runId) as {
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
      execution: latest
        ? {
            recordId: latest.record_id,
            number: latest.number,
            finished: latest.finished_at !== null,
          }
        : null,
      resultPending: latest ? pendingResults.has(latest.record_id) : false,
    })
    if (decision.action !== 'start') {
      return {
        recordId: decision.executionRecordId,
        number: decision.executionNumber,
        requestedAt: latest!.requested_at,
        introduction: formatGateRequestDecision(decision),
      }
    }
    const inserted = requestGateExecution(runId, 'worker-check')
    const requestedAt = inserted.requestedAt
    return {
      recordId: inserted.recordId,
      number: inserted.number,
      requestedAt,
      introduction: null,
    }
  })
}

function selectGateExecution(runId: string, pendingResults: ReadonlySet<string>): RequestedGate {
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

function gateResultLogPaths(runId: string, executionNumber: number, artifactPath: string | null) {
  if (!artifactPath) return {}
  return {
    outputPath: `${runScratchDir(runId)}/gate-${executionNumber}.log`,
    artifactPath,
  }
}

function formatPendingGateWait(message: string, outputTail: string | null): string {
  return `${message}${outputTail ? `\n${outputTail}` : ''}`
}

async function waitForGateExecution(
  runId: string,
  requested: Exclude<RequestedGate, { message: string }>,
  pendingResults: Set<string>,
  dependencies: GateWaitDependencies,
  signal: AbortSignal,
): Promise<string> {
  const recordId = requested.recordId
  pendingResults.add(recordId)
  const waitStartedAt = dependencies.now()
  // A caller that disappears without sending cancellation can still consume a later result.
  for (;;) {
    if (signal.aborted) return 'The check wait stopped because the run_check call was cancelled.'
    const row = db()
      .query(
        `SELECT g.exit_code,g.timed_out,g.elapsed_ms,g.output_tail,g.output_artifact,
                g.cancelled_reason,r.status,r.gate_requests_closed
         FROM gate_execution g JOIN run r ON r.record_id=g.run_record_id WHERE g.record_id=?`,
      )
      .get(recordId) as {
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
      pendingResults.delete(recordId)
      const result = formatGateResult(
        shapeGateResult({
          exitCode: row.exit_code!,
          timedOut: row.timed_out === 1,
          elapsedMs: row.elapsed_ms!,
          output: row.output_tail ?? '',
          ...gateResultLogPaths(runId, requested.number, row.output_artifact),
        }),
      )
      return requested.introduction ? `${requested.introduction}\n${result}` : result
    }
    if (!waitDecision.wait) return formatPendingGateWait(waitDecision.message!, row.output_tail)
    await waitForGatePoll(
      Math.min(POLL_MS, dependencies.waitMs - (now - waitStartedAt)),
      signal,
      dependencies.wait,
    )
  }
}

async function requestGate(
  runId: string,
  pendingResults: Set<string>,
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
 * The row is written before the wait so the question is visible in `bottega question inbox`
 * immediately — a worker blocked on a question nobody can see is the failure
 * this whole channel exists to remove, and it would look exactly like a hung
 * agent.
 */
export async function ask(o: {
  runId: string
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
    db().query("UPDATE run SET status='asking' WHERE record_id=? AND status='running'").run(o.runId)
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
  const q = db().query(
    'SELECT answer FROM question WHERE record_id = ? AND answered_at IS NOT NULL',
  )

  // BOUNDED BY CONSTRUCTION, like `bottega run wait`. An unbounded poll against a
  // question nobody will ever answer is the failure this is meant to remove
  // rather than relocate.
  for (;;) {
    const row = q.get(id) as { answer: string | null } | null
    if (row) {
      db()
        .query("UPDATE run SET status='running' WHERE record_id=? AND status='asking'")
        .run(o.runId)
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
    await new Promise((r) => setTimeout(r, Math.min(POLL_MS, Math.max(0, deadline - Date.now()))))
  }
}

/**
 * The run id comes from the ENVIRONMENT, not from the tool arguments. A worker
 * that had to name its own run could name someone else's, and in a fan-out that
 * is not hypothetical — several workers are alive at once and each one's idea
 * of "my run id" would be a guess. `BOTTEGA_RUN_ID` is set by the process that
 * spawned the agent, which is the only party that actually knows.
 */
type AskServerDependencies = {
  fileWorkerNote(run: WorkerNoteRun, input: WorkerNoteInput): Promise<WorkerNoteFiledResult>
  gate?: GateWaitDependencies
  lifecycle?: AskLifecycle
}

function workerNoteRun(runId: string): WorkerNoteRun {
  const row = db()
    .query(
      `SELECT r.number AS id,r.record_id,p.name AS project,p.path AS project_path,
              COALESCE(r.worktree,r.cwd) AS tree,r.branch,
              r.session_id,r.head_commit
         FROM run r JOIN project p ON p.record_id=r.project_record_id WHERE r.record_id=?`,
    )
    .get(runId) as {
    id: number
    record_id: string
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
    recordId: row.record_id,
    project: row.project,
    projectPath: row.project_path,
    tree: row.tree,
    branch: row.branch,
    sessionId: row.session_id,
    headCommit: row.head_commit,
  }
}

function registerRunCheckTool(input: {
  registerTool: McpServer['registerTool']
  runId: string
  token: string
  pendingResults: Set<string>
  dependencies?: GateWaitDependencies
  text(
    value: string,
    isError?: true,
  ): {
    content: Array<{ type: 'text'; text: string }>
    isError?: true
  }
}): void {
  input.registerTool(
    'run_check',
    {
      description:
        "Run this project's cheap worker check in the run worktree through the supervising orchestrator. " +
        'The command, directory, and environment are fixed by orchestrator and take no worker input.',
      inputSchema: z.object({}),
    },
    async (_arguments, context) => {
      try {
        const eligibility = checkEligibility(input.runId, input.token)
        if (!eligibility.eligible) return input.text(eligibility.message)
        return input.text(
          await requestGate(
            input.runId,
            input.pendingResults,
            context.mcpReq.signal,
            input.dependencies,
          ),
        )
      } catch (error) {
        return input.text(`The registered worker check could not be run (${String(error)}).`, true)
      }
    },
  )
}

function askServerState(runId: string, dependencies: AskServerDependencies) {
  return [new Set<string>(), dependencies.lifecycle ?? askLifecycle(runId), [] as string[]] as const
}

export function createAskMcpServer(
  runId: string,
  token: string,
  timeoutMs?: number,
  dependencies: AskServerDependencies = { fileWorkerNote: requestWorkerNote },
): McpServer {
  /**
   * WHETHER THIS PROCESS IS ACTUALLY THE WORKER IT CLAIMS TO BE.
   *
   * The server is registered globally with codex and grok, so ANY process on
   * this machine can launch it with `BOTTEGA_RUN_ID=42` and post questions that
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
  const [pendingGateResults, lifecycle, toolNames] = askServerState(runId, dependencies)
  const server = new McpServer({ name: WORKER_MCP_SERVER_NAME, version: '1' })
  const registerTool = ((...args: unknown[]) => {
    if (typeof args[0] === 'string') toolNames.push(args[0])
    return Reflect.apply(server.registerTool, server, args)
  }) as typeof server.registerTool
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
  toolNames.push(...registerAskBoardTools({ server, runId, authorized, unauthorized, text }))

  registerTool(
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

  // Readers and inline jobs do not receive an execution surface.
  if (checkToolAvailable(runId, token)) {
    registerRunCheckTool({
      registerTool,
      runId,
      token,
      pendingResults: pendingGateResults,
      dependencies: dependencies.gate,
      text,
    })
  }
  if (focusedTestToolAvailable(runId, token)) {
    registerFocusedTestTool({ registerTool, runId, token, text })
  }

  if (gateResultToolAvailable(runId, token)) {
    registerTool(
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

  registerTool(
    'note',
    {
      description:
        'File an observation about a defect outside your assigned task. Keep findings about ' +
        'your own task in your final reply. The orchestrator derives the project and run anchors; ' +
        'you may optionally anchor the observation to a relative path and line.',
      inputSchema: z.object({
        text: requiredTextReachingHandler.describe('One non-empty line describing the defect.'),
        project: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe('Registered target project; defaults to the run project.'),
        file: z
          .preprocess(
            (value) => (value === undefined ? undefined : String(value)),
            z.string().optional(),
          )
          .describe('Optional relative path:line inside this run tree.'),
        same_as: z
          .string()
          .min(1)
          .optional()
          .describe('A note label, UUID, or project-local number.'),
      }),
    },
    async ({ text: noteText, project, file, same_as }) => {
      try {
        if (!authorized()) throw new Error(unauthorized())
        const input = validateWorkerNoteInput({ text: noteText, project, file, sameAs: same_as })
        const filed = await dependencies.fileWorkerNote(workerNoteRun(runId), input)
        return text(
          JSON.stringify({
            noteRecordId: filed.noteRecordId,
            noteLabel: filed.noteLabel,
            candidates: filed.candidateNotes,
            ...(filed.anchorDropped ? { anchorDropped: filed.anchorDropped } : {}),
          }),
        )
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

  registerTool(
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
        return text(
          `Message ${saved.number} recorded on run ${saved.root_run_record_id}. Keep working.`,
        )
      } catch (error) {
        return text(`The message was not recorded (${String(error)}).`, true)
      }
    },
  )

  registerTool(
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
          ...messages.map((note) => `[message ${note.number}] ${note.body}`),
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
      lifecycle.initialized()
    } catch {
      // Lifecycle evidence must never break a completed handshake.
    }
  }
  return server
}

export type AskLoopback = {
  kind: 'endpoint' | 'stdio-loopback'
  url: string
  close(): Promise<void>
}

/** Build the authenticated streamable-HTTP seam without opening a socket. */
export function createAskHttpHandler(
  runId: string,
  token: string,
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (!token || request.headers.get('authorization') !== `Bearer ${token}`) {
      return new Response('Unauthorized', { status: 401 })
    }
    const askServer = createAskMcpServer(runId, token)
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    await askServer.connect(observeAskTransport(transport, runId))
    try {
      return await transport.handleRequest(request)
    } finally {
      await askServer.close()
    }
  }
}

/** Start a token-authenticated streamable-HTTP MCP endpoint on one loopback port. */
export function startAskHttpEndpoint(runId: string, token: string): AskLoopback {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    idleTimeout: LOCAL_LISTENER_IDLE_TIMEOUT_SECONDS,
    port: 0,
    fetch: createAskHttpHandler(runId, token),
  })
  return {
    kind: 'endpoint',
    url: `http://127.0.0.1:${server.port}/mcp`,
    close: async () => {
      await server.stop(true)
    },
  }
}

/**
 * Start the database-owning side of bottega-ask outside a worker's process sandbox.
 * The OS chooses the port, and the listener is bound only to loopback.
 */
export async function startAskLoopback(runId: string, token: string): Promise<AskLoopback> {
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
    throw new Error(`${WORKER_MCP_SERVER_NAME} loopback did not receive a TCP port`)
  }
  return {
    kind: 'stdio-loopback',
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
    throw new Error('BOTTEGA_ASK_URL must name a tcp://127.0.0.1:<port> endpoint')
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

/**
 * The two store-facing steps of the ask-server entry, in the order it must run them.
 *
 * The declaration is FIRST. This process runs from a worker-classified environment, and its
 * question, message and gate rows ARE the worker's escalation channel, so it is the one
 * declared broker channel that may write the store. A store opened before the declaration
 * would open read-only and could never be written through afterwards. Migration stays refused
 * here, this process included. Injectable so a beside-test can pin that order without
 * spawning a server.
 */
export type AskServerStoreSteps = {
  declareBrokerChannel(): void
  openStore(): Database
}

const askServerStoreSteps: AskServerStoreSteps = {
  declareBrokerChannel: declareStoreBrokerChannel,
  openStore: db,
}

export async function serveAsk(steps: AskServerStoreSteps = askServerStoreSteps): Promise<void> {
  const loopback = process.env.BOTTEGA_ASK_URL
  if (loopback) return proxyAsk(loopback)
  steps.declareBrokerChannel()
  const runId = resolveRunIdentifier(steps.openStore(), process.env.BOTTEGA_RUN_ID ?? '')
  enableRunSchemaReload(runId)
  const token = process.env.BOTTEGA_RUN_TOKEN ?? ''
  serveStdio(() => createAskMcpServer(runId, token), {
    transport: observeAskTransport(new StdioServerTransport(), runId),
    onerror: writeAskServerFailure,
  })
}
