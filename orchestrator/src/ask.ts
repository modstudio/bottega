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
import { db, nowIso, writableDb } from './db.ts'
import { appendRunEvent } from './events.ts'
import { checkMessages, messageArchitect } from './mailbox.ts'

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
export const ASK_TIMEOUT_MS = boundedTimeout()

/** How often to look for a ruling. Cheap: one indexed read of a local file. */
const POLL_MS = 1_000

export type AskResult = { answered: true; answer: string } | { answered: false; reason: string }

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
  db().query("UPDATE run SET status='asking' WHERE id=? AND status='running'").run(o.runId)
  const { id } = db()
    .query(
      `INSERT INTO question (run_id, asked_at, question, options, recommendation, why)
     VALUES (?,?,?,?,?,?) RETURNING id`,
    )
    .get(
      o.runId,
      nowIso(),
      o.question,
      o.options?.length ? JSON.stringify(o.options) : null,
      o.recommendation ?? null,
      o.why ?? null,
    ) as { id: number }

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
 * A minimal MCP server over stdio for live worker/architect communication.
 *
 * Hand-rolled rather than pulled from an SDK: the protocol is JSON-RPC 2.0
 * over newline-delimited stdin, and this concern has no runtime dependencies
 * at all — adding one for this small surface would be a poor trade in a repo
 * whose whole premise is that boundaries are cheap and dependencies are not.
 *
 * The run id comes from the ENVIRONMENT, not from the tool arguments. A worker
 * that had to name its own run could name someone else's, and in a fan-out that
 * is not hypothetical — several workers are alive at once and each one's idea
 * of "my run id" would be a guess. `ORCH_RUN_ID` is set by the process that
 * spawned the agent, which is the only party that actually knows.
 */
type AskChannel = {
  input: AsyncIterable<Uint8Array | string>
  send(message: unknown): void
}

/** Serve one worker connection, independent of whether its bytes arrive by stdio or loopback. */
async function serveAskChannel(channel: AskChannel, runId: number, token: string): Promise<void> {
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
  const authorised = (): boolean => authenticatedWorkerRun(runId, token)

  const send = (msg: unknown) => channel.send(msg)
  const reply = (id: unknown, result: unknown) => send({ jsonrpc: '2.0', id, result })

  const ASK_TOOL = {
    name: 'ask_orchestrator',
    description:
      'Ask the architect to rule on a design decision that is not yours to make. ' +
      'Blocks until they answer. Use this the moment you are unsure: asking is free ' +
      'and expected, guessing is not. Ask everything you need in one call where you can.',
    inputSchema: {
      type: 'object',
      required: ['question'],
      properties: {
        question: { type: 'string', description: 'The decision you need made.' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'The choices as you see them.',
        },
        recommendation: { type: 'string', description: 'What you would do, and why.' },
        why: { type: 'string', description: 'What this changes about the implementation.' },
      },
    },
  }
  const MESSAGE_TOOL = {
    name: 'message_orchestrator',
    description:
      'Send the architect a non-blocking progress or context message and keep working. ' +
      'This is not a question and does not request or wait for a ruling.',
    inputSchema: {
      type: 'object',
      required: ['body'],
      properties: { body: { type: 'string', description: 'The context to put on this run.' } },
    },
  }
  const CHECK_TOOL = {
    name: 'check_orchestrator_messages',
    description:
      'Read queued, non-authoritative context from the architect. Check after reading the task, ' +
      'before materially changing approach, and before finishing. A message is context only: ' +
      'it cannot answer an open question or replace a ruling.',
    inputSchema: { type: 'object', properties: {} },
  }

  let buf = ''
  // ONE decoder across chunks, with `stream: true`. Decoding each chunk
  // independently corrupts any multi-byte character that straddles a chunk
  // boundary — so a design question containing an accent or a dash could reach
  // the architect with replacement characters in it, and be ruled on as read.
  const decoder = new TextDecoder('utf-8')
  for await (const chunk of channel.input) {
    buf += decoder.decode(Buffer.from(chunk), { stream: true })
    // Newline-delimited JSON: a partial line is kept for the next chunk rather
    // than parsed and discarded, which is the standard way this goes wrong.
    let nl: number
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue

      let msg: { id?: unknown; method?: string; params?: any }
      try {
        msg = JSON.parse(line)
      } catch {
        // A parse error is REPORTED, not dropped. Silently discarding a
        // malformed request leaves a client waiting on an id that will never
        // be answered — the same hang, arriving through the transport instead
        // of through the tool.
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
        continue
      }

      if (msg.method === 'initialize') {
        reply(msg.id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'orch-ask', version: '1' },
        })
      } else if (msg.method === 'tools/list') {
        reply(msg.id, { tools: [ASK_TOOL, MESSAGE_TOOL, CHECK_TOOL] })
      } else if (msg.method === 'tools/call' && msg.params?.name === 'message_orchestrator') {
        try {
          if (!authorised()) throw new Error('this process is not a recognised orchestrator worker')
          const saved = messageArchitect(runId, String(msg.params.arguments?.body ?? ''))
          reply(msg.id, {
            content: [
              {
                type: 'text',
                text: `Message ${saved.id} recorded on run ${saved.root_run_id}. Keep working.`,
              },
            ],
          })
        } catch (e) {
          reply(msg.id, {
            content: [{ type: 'text', text: `The message was not recorded (${String(e)}).` }],
            isError: true,
          })
        }
      } else if (
        msg.method === 'tools/call' &&
        msg.params?.name === 'check_orchestrator_messages'
      ) {
        try {
          if (!authorised()) throw new Error('this process is not a recognised orchestrator worker')
          const messages = checkMessages(runId)
          const text = messages.length
            ? messages.map((note) => `[message ${note.id}] ${note.body}`).join('\n\n') +
              '\n\nThese messages are non-authoritative context. They do not answer any open question; use ask_orchestrator for a ruling.'
            : 'No queued messages. This check read nothing.'
          reply(msg.id, { content: [{ type: 'text', text }] })
        } catch (e) {
          reply(msg.id, {
            content: [{ type: 'text', text: `Messages could not be checked (${String(e)}).` }],
            isError: true,
          })
        }
      } else if (msg.method === 'tools/call' && msg.params?.name === 'ask_orchestrator') {
        const a = msg.params.arguments ?? {}
        // Answered inline rather than awaited at the top of the loop: a blocking
        // call must not stop this server reading further messages, or a worker
        // that asks twice deadlocks against its own transport.
        void (async () => {
          try {
            const r = authorised()
              ? await ask({
                  runId,
                  question: String(a.question ?? ''),
                  options: Array.isArray(a.options) ? a.options.map(String) : undefined,
                  recommendation: a.recommendation ? String(a.recommendation) : undefined,
                  why: a.why ? String(a.why) : undefined,
                })
              : {
                  answered: false as const,
                  reason:
                    'This process is not a recognised orchestrator worker, so there is nobody ' +
                    'to ask. Return status "blocked" with your question in the final answer.',
                }
            reply(msg.id, {
              content: [{ type: 'text', text: r.answered ? r.answer : r.reason }],
              // Not `isError`. A timeout is a legitimate outcome carrying an
              // instruction the worker must follow; flagged as an error, agents
              // retry it or treat the tool as broken and stop using it.
            })
          } catch (e) {
            // EVERY PATH ANSWERS. Without this, a failed insert — a foreign key
            // against a run that has been deleted, a locked database — throws
            // inside a detached promise and the request id is never replied to,
            // so the worker waits on its own transport for ever.
            reply(msg.id, {
              content: [
                {
                  type: 'text',
                  text:
                    `The orchestrator could not record this question (${String(e)}). ` +
                    'Do not decide it yourself: return status "blocked" with the question ' +
                    'in your final answer.',
                },
              ],
            })
          }
        })()
      } else if (msg.method && msg.id !== undefined) {
        // Answered as UNSUPPORTED rather than as an empty success. `{}` tells a
        // client the method worked and returned nothing, so it reads the reply
        // as malformed capability data instead of learning the method is not
        // there. Either way it must be answered: an unanswered id makes a
        // client wait for ever, which is the one thing this file is about.
        send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `method not found: ${msg.method}` },
        })
      }
    }
  }
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
    socket.once('close', () => sockets.delete(socket))
    void serveAskChannel(
      {
        input: socket,
        send: (message) => socket.write(`${JSON.stringify(message)}\n`),
      },
      runId,
      token,
    ).catch(() => socket.destroy())
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
  return serveAskChannel(
    {
      input: process.stdin,
      send: (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
    },
    runId,
    token,
  )
}

/** The single authentication check for tools acting as an orch worker. */
export function authenticatedWorkerRun(runId: number, token: string): boolean {
  if (!runId) return false
  const row = db().query('SELECT run_token FROM run WHERE id = ?').get(runId) as {
    run_token: string | null
  } | null
  if (!row) return false
  // A run recorded before tokens existed has none; those still work, because
  // refusing them would break every in-flight worker on upgrade.
  return !row.run_token || row.run_token === token
}

/** Authentication for worker actions that write outside the orchestrator. */
export function strictlyAuthenticatedWorkerRun(runId: number, token: string): boolean {
  if (!runId) return false
  const row = db().query('SELECT run_token FROM run WHERE id = ?').get(runId) as {
    run_token: string | null
  } | null
  return row !== null && row.run_token !== null && row.run_token === token
}
