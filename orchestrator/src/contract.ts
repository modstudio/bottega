/**
 * What an implementation worker is told, and what it must hand back.
 *
 * The premise of delegating implementation is narrow and worth stating exactly,
 * because everything here follows from it. The standing objection to fanning
 * out code-writing is that parallel workers make conflicting IMPLICIT
 * decisions — a background in one style, a sprite in another, and nothing
 * merges. The load-bearing word is *implicit*. A worker that must stop and ask
 * whenever it reaches a judgement call converts an implicit decision into an
 * explicit one and routes it to the single place holding the whole design.
 *
 * So the worker is not a small architect. It is a builder with a spec, and the
 * one thing it must never do is decide. That is a behavioural contract, and a
 * behavioural contract stated only in prose is a request. Bound to a schema it
 * is enforced: `status` is an enum the model cannot answer outside of, so
 * "blocked" is a value rather than a phrase somebody has to notice in a
 * paragraph.
 *
 * WHICH IS WHY SCHEMA SUPPORT DECIDES A LOT HERE. grok's `--json-schema`
 * constrains the model; codex's `--output-schema` is silently dropped when MCP
 * tools are active, which yields near-JSON rather than an error. The parser
 * below therefore treats the schema as a strong hint and not a guarantee: it
 * recovers a fenced or embedded object, because the alternative is losing a
 * completed implementation to a stray prose sentence.
 */

/**
 * The shape a worker's final message must take.
 *
 * EVERY PROPERTY IS IN `required`, and optional ones are nullable instead.
 * That is not a style choice: OpenAI's structured-output validator rejects a
 * schema with `additionalProperties: false` unless `required` lists every key
 * in `properties`, and it rejects it with a 400 that kills the run before the
 * agent does any work at all —
 *
 *   invalid_json_schema: 'required' is required to be supplied and to be an
 *   array including every key in properties. Missing 'options'.
 *
 * A worker with nothing to report therefore sends `null` rather than omitting
 * the field, which is also the more honest encoding: "I asked no questions" and
 * "I did not address whether I had questions" are different claims, and only
 * one of them should be silence.
 */
const nullableStrings = { type: ['array', 'null'], items: { type: 'string' } } as const

export const WORKER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'summary', 'files_changed', 'questions', 'deviations', 'tests', 'blockers'],
  properties: {
    status: {
      type: 'string',
      enum: ['done', 'asking', 'refused'],
      description:
        'done: the spec is fully implemented. asking: you reached a decision that is not yours to make and stopped to ask. refused: the spec cannot be implemented as written.',
    },
    summary: { type: 'string', description: 'What you did, in a few sentences.' },
    files_changed: nullableStrings,
    questions: {
      type: ['array', 'null'],
      description: 'Required when status is asking. The rulings you need. Null if none.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['question', 'options', 'recommendation', 'why'],
        properties: {
          question: { type: 'string' },
          options: nullableStrings,
          recommendation: { type: ['string', 'null'] },
          why: {
            type: ['string', 'null'],
            description: 'Why this changes the implementation.',
          },
        },
      },
    },
    deviations: {
      type: ['array', 'null'],
      description:
        'Anywhere you did something the spec did not say, or did not do something it did say. Null if none.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['what', 'why'],
        properties: {
          what: { type: 'string' },
          why: { type: 'string' },
        },
      },
    },
    /**
     * WHAT STOPPED YOU VERIFYING — reported even when the work was finished.
     *
     * This exists because the information was already arriving and nobody was
     * catching it. Four review runs in one session said, unprompted and in
     * prose, that they could not run anything: the Docker socket was denied,
     * PHP was not on the host, an npm native binding was missing for the
     * architecture. One of them downgraded its entire test verdict to "static
     * review" as a result. All of it sat in free text that no query could
     * reach, so a blocker capping every review on this machine looked exactly
     * like no blocker at all.
     *
     * Separate from `questions`, and the distinction matters: a question is
     * something only the ARCHITECT can answer, and the worker stops. A blocker
     * is something only the ENVIRONMENT can fix, and the worker carries on
     * without it — so it must be reported alongside a completed run rather than
     * instead of one.
     */
    blockers: {
      type: ['array', 'null'],
      description:
        'Anything that stopped you verifying your work — a tool you could not run, a permission denied, a service you could not reach. Report these even if you finished. Null if none.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['what', 'why', 'impact'],
        properties: {
          what: { type: 'string', description: 'What you could not do.' },
          why: { type: 'string', description: 'The error or refusal, as exactly as you can.' },
          impact: {
            type: 'string',
            description: 'What this cost — what you could not check as a result.',
          },
        },
      },
    },
    tests: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['command', 'ran', 'passed', 'detail'],
      properties: {
        command: { type: ['string', 'null'] },
        ran: { type: 'boolean' },
        passed: { type: ['boolean', 'null'] },
        detail: { type: ['string', 'null'] },
      },
    },
  },
} as const

export type WorkerReply = {
  status: 'done' | 'asking' | 'refused'
  summary: string
  // Nullable throughout, because the schema requires the keys to be present and
  // a worker with nothing to report sends null rather than omitting them.
  files_changed?: string[] | null
  questions?: {
    question: string; options?: string[] | null
    recommendation?: string | null; why?: string | null
  }[] | null
  deviations?: { what: string; why: string }[] | null
  blockers?: { what: string; why: string; impact: string }[] | null
  tests?: { command?: string | null; ran?: boolean; passed?: boolean | null; detail?: string | null } | null
}

/**
 * The standing instructions a worker gets on top of its spec.
 *
 * Deliberately about ROLE rather than about tools. What goes wrong when an
 * agent is handed an implementation task is not that it cannot code; it is that
 * it quietly resolves an ambiguity in the spec and builds on its own answer,
 * and the disagreement only surfaces at review — by which point the wrong
 * decision has structure built on top of it.
 *
 * ASKING IS EXPLICITLY FREE. That sentence is in here because without it a
 * model reads "escalate design decisions" as a reluctant escape hatch and tries
 * to avoid using it, which produces exactly the silent guessing the channel
 * exists to prevent. The scoring model backs the promise up: escalating counts
 * as faithful, and guessing is what costs.
 */
export const WORKER_PREAMBLE = `
YOUR ROLE

You are an implementation worker. Someone else — the architect — has designed
this change, holds the whole picture, and will review what you produce. Your job
is to implement the spec below faithfully. It is not to improve it.

You are working in a throwaway git worktree cut for this run. Edit files freely.
Do NOT commit, do NOT push, do NOT merge, and do not touch git history: the
architect reads your diff and decides what happens to it.

WHEN YOU REACH A DECISION THAT IS NOT YOURS

Stop and ask. Return status "asking" with your questions and nothing else half
done. A decision is not yours whenever the spec is genuinely open — two
reasonable designs fit it, it contradicts what the code already does, it needs a
new dependency, it changes a public interface or a database schema, or doing it
properly means touching something the spec never mentioned.

ASKING COSTS YOU NOTHING. It is not a failure and it is not a last resort; it is
the single most useful thing you can do, and it is scored as faithful work.
Guessing is what costs. A wrong guess with code built on top of it is far more
expensive to undo than a question answered in one turn — and because your
session is resumed rather than restarted, you keep everything you have already
read. Answering costs you one short turn.

Ask EVERYTHING you need in one go rather than one question at a time: each round
trip costs the architect a turn, and three questions asked together are cheaper
than three asked in sequence.

IF THE SPEC IS SIMPLY WRONG

Return status "refused" and say why. Do not implement something you believe is
mistaken in order to be agreeable.

WHAT TO REPORT

Reply with a single JSON object matching the required schema. Be honest in
"deviations": anything you did that the spec did not ask for, or asked for and
you did not do, goes there. An unreported deviation is the one failure this
system cannot catch automatically, and hiding one costs far more than admitting
it. Run the project's tests if you can, and report what actually happened rather
than what you expect would happen.

REPORT WHAT STOPPED YOU, IN "blockers"

If anything prevented you from verifying your work — a tool that would not run,
a permission denied, a service you could not reach, a missing binary — put it in
"blockers" even if you finished the task anyway. Say what you could not do, the
error as exactly as you can quote it, and what it cost you: which check you could
not perform, which verdict you had to reach by reading instead of running.

This is not a complaint and it does not count against you. It is the only way
these get fixed. An environment problem capping every run on this machine is
invisible if each worker quietly works around it and says nothing — and workers
have been doing exactly that, mentioning a denied Docker socket in passing while
reporting a test verdict they could not actually test.

A BLOCKER IS NOT A QUESTION. A question is something only the architect can
answer, and you stop and wait. A blocker is something only the environment can
fix, and you carry on without it and say so.
`.trim()

/** The ruling, wrapped so a resumed worker knows what it is reading. */
export function rulingPrompt(answers: { question: string; answer: string }[]): string {
  const body = answers
    .map((a, i) => `${i + 1}. YOU ASKED: ${a.question}\n   THE RULING: ${a.answer}`)
    .join('\n\n')
  return [
    'The architect has ruled on what you asked. These are decisions, not suggestions:',
    '',
    body,
    '',
    'Continue implementing the spec on that basis. If a ruling opens a NEW decision',
    'that is not yours, stop and ask again — the same terms apply and asking is still',
    'free. Otherwise finish the work and return status "done".',
  ].join('\n')
}

/**
 * Recover the worker's structured reply from whatever actually came back.
 *
 * Three fallbacks, in descending order of how well-behaved the agent was,
 * because losing a finished implementation to a formatting slip would be an
 * absurd way to fail:
 *
 *   1. the whole reply is the object (a schema-constrained agent)
 *   2. it is inside a fenced block (a model that explained itself first)
 *   3. it is the outermost braces anywhere in the text
 *
 * Returns null when nothing parses, and the caller treats THAT as its own kind
 * of failure rather than as `done`. Assuming success from an unreadable reply
 * is how a run that never touched the code gets recorded as a completed one.
 */
type JsonSchema = {
  type?: string | readonly string[]
  properties?: { readonly [key: string]: JsonSchema }
  required?: readonly string[]
  items?: JsonSchema
  enum?: readonly unknown[]
  anyOf?: readonly JsonSchema[]
  additionalProperties?: boolean
}

function validatesSchema(value: unknown, schema: JsonSchema): boolean {
  if (schema.anyOf && !schema.anyOf.some((choice) => validatesSchema(value, choice))) return false
  if (schema.enum && !schema.enum.some((item) => Object.is(item, value))) return false

  const types = typeof schema.type === 'string' ? [schema.type] : schema.type
  if (types) {
    const matches = types.some((type) => {
      if (type === 'null') return value === null
      if (type === 'array') return Array.isArray(value)
      if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value)
      return typeof value === type
    })
    if (!matches) return false
  }

  if (Array.isArray(value) && schema.items) {
    return value.every((item) => validatesSchema(item, schema.items!))
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Record<string, unknown>
    if (schema.required?.some((key) => !Object.hasOwn(object, key))) return false
    // additionalProperties:false is NOT enforced here. The schema declares it
    // so a schema-bound agent cannot invent fields, but a worker that did the
    // work and added one stray key has not stopped doing the work, and
    // rejecting the reply would throw a finished implementation away over a
    // field nobody reads.
    if (schema.properties) {
      for (const [key, child] of Object.entries(schema.properties)) {
        if (Object.hasOwn(object, key) && !validatesSchema(object[key], child)) return false
      }
    }
  }
  return true
}

export type ParsedWorkerReply = { reply: WorkerReply | null; contractObjects: number }

export function parseWorkerReplyWithCount(text: string): ParsedWorkerReply {
  const t = text.trim()

  /**
   * SEVERAL objects can arrive, and the LAST one is the answer.
   *
   * A worker under a schema narrates in the same shape it was told to reply in:
   * one run opened with `{"status":"done","summary":"Starting by reading the
   * canon...","files_changed":[]}` and emitted its real reply afterwards. Taking
   * the span from the first `{` to the last `}` covers both and parses as
   * neither, so a completed change set — three files, 150 lines — was recorded
   * as "reply did not match the worker contract".
   *
   * Worse than losing it would be BELIEVING the first: it says `done` with no
   * files, which is a confident report of having finished nothing.
   *
   * So the objects are scanned out by brace depth, honouring strings and
   * escapes, and offered newest first. Depth-scanned rather than regexed
   * because a JSON object nests, and a brace inside a summary string is not a
   * brace.
   */
  const objects: string[] = []
  let depth = 0, start = -1, inStr = false, esc = false
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === '{') { if (depth === 0) start = i; depth++; continue }
    if (ch === '}') {
      depth--
      if (depth === 0 && start !== -1) { objects.push(t.slice(start, i + 1)); start = -1 }
    }
  }
  objects.reverse()
  const valid: WorkerReply[] = []
  for (const c of objects) {
    try {
      let o = JSON.parse(c)
      // An unknown status is not a reply we can act on. Treating it as `done`
      // would silently accept an unfinished run; treating it as unparseable
      // sends it down the path that says so.
      /**
       * `blocked` is still accepted, and normalised.
       *
       * The word was renamed to `asking` because a "blocker" here means the
       * opposite — an environment problem rather than a worker behaving
       * correctly — but an agent whose schema was dropped, or which is
       * echoing older instructions, will still say `blocked`. Rejecting the
       * reply over a synonym would throw away a completed implementation.
       */
      if (o && typeof o === 'object' && !Array.isArray(o) && o.status === 'blocked') {
        o = { ...o, status: 'asking' }
      }
      /**
       * The NESTED shapes are checked too, not just `status`.
       *
       * `{"status":"blocked","questions":[null]}` satisfied every test here
       * and then threw on `item.question` while run() was writing its
       * terminal row — inside the `finally`, so the row stayed `running` for
       * ever with no process behind it. Anything malformed is dropped rather
       * than rejecting the whole reply: a worker that did the work and
       * garbled one question should not lose the work, and a `blocked` reply
       * left with no usable questions falls into the dead-end branch that
       * already handles exactly that.
       *
       * Schema validation now supersedes that recovery policy: a malformed
       * nested value rejects this candidate before any part of it is acted on.
       */
      if (validatesSchema(o, WORKER_SCHEMA)) valid.push(o as WorkerReply)
    } catch { /* try the next shape */ }
  }
  return { reply: valid[0] ?? null, contractObjects: valid.length }
}

export function parseWorkerReply(text: string): WorkerReply | null {
  return parseWorkerReplyWithCount(text).reply
}


/**
 * Whether a reply is a worker stopping to ask.
 *
 * A plain boolean rather than a type predicate on purpose: predicated, it
 * narrows the ELSE branches to `null` and every later `contract?.status`
 * becomes `never`, which is both wrong and confusing to read.
 */
export function isAsking(r: WorkerReply | null | undefined): boolean {
  return r?.status === 'asking'
}

/**
 * What a READ-ONLY worker is told, and it is short on purpose.
 *
 * A read-only job runs in the caller's real checkout, not a worktree, because a
 * lens usually needs the uncommitted work a fresh tree would not have. The disk
 * is read-only now, so this is no longer the thing standing between a lens and
 * somebody's afternoon — but the sandbox stops a write, it does not stop an
 * agent from BELIEVING it should make one, and a formatter it thought it ran is
 * a finding it will report having verified.
 *
 * Named commands rather than a principle: a reviewer that has been told "do not
 * modify" still reaches for `lint:fix` to see what lint would say.
 */
export const READONLY_PREAMBLE = `
YOU ARE READING, NOT CHANGING.

You are running in someone's REAL working checkout, which very likely holds
uncommitted work — that is usually the whole point of what you were asked to
look at. It is not a scratch copy and there is no worktree to throw away.

Do not write to it. In particular do not run a formatter or a fixer to see what
it would say: no \`lint:fix\`, no \`--write\`, no \`--fix\`, no \`prettier\`, no
\`git checkout\`/\`restore\`/\`stash\`/\`reset\`/\`clean\`. Read the config and say
what you believe it would report instead.

Your disk is read-only, so an attempt will fail rather than damage anything. Say
so plainly if that happens — a refused write is a fact worth reporting, not an
obstacle to work around.
`.trim()
