// concern: contract

import { isReaderJob, type Job } from '../jobs/jobs.ts'
import { GENERIC_QUESTION_TOKENS } from '../outcome.ts'
import { REVIEW_SEVERITY } from '../review/review-vocabulary.ts'
import { progressFileInstruction } from '../run/checkpoint.ts'

export {
  hasRealQuestions,
  realQuestions,
} from '../outcome.ts'

/**
 * What an implementation worker is told, and what it must hand back.
 *
 * The premise of delegating implementation is narrow and worth stating exactly,
 * because everything here follows from it. The standing objection to fanning
 * out code-writing is that parallel workers make conflicting IMPLICIT
 * decisions — a background in one style, a sprite in another, and nothing
 * merges. The load-bearing word is *implicit*. A worker that must stop and ask
 * whenever it reaches a judgment call converts an implicit decision into an
 * explicit one and routes it to the single place holding the whole design.
 *
 * So the worker is not a small architect. It is a builder with a spec, and the
 * one thing it must never do is decide. That is a behavioral contract, and a
 * behavioral contract stated only in prose is a request. Bound to a schema it
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

/** On-disk contract for jobs whose public result remains plain text. */
export const TEXT_REPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answer'],
  properties: { answer: { type: 'string' } },
} as const

/** Prompt-facing name of TEXT_REPLY_SCHEMA; the printed result stays the unwrapped string. */
const TEXT_REPLY_SCHEMA_NAME = 'text-reply'

export const REPLY_FILE_NAME = 'reply.json'

/** The file contract is identical across harnesses; schema flags are an extra guarantee. */
export function replyFileInstruction(schemaName: string, scratchDir: string): string {
  return (
    `REPLY CONTRACT\n\n` +
    `Your reply schema is ${schemaName}. Before your final message, write the structured reply ` +
    `as valid JSON to ${scratchDir}/${REPLY_FILE_NAME}. Orch reads that file first and falls back ` +
    `to the final message only when the file is missing. The final message must follow the same schema.` +
    (schemaName === 'WORKER_SCHEMA' || schemaName === 'ISSUE_WORKER_SCHEMA'
      ? `\n\n${progressFileInstruction(scratchDir)}`
      : '')
  )
}

/** Contract and separator bytes reserved before a run has its concrete scratch path. */
export function replyFileBytes(schemaName: string, scratchDir: string): number {
  return Buffer.byteLength(replyFileInstruction(schemaName, scratchDir)) + 2
}

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
  questions?:
    | {
        question: string
        options?: string[] | null
        recommendation?: string | null
        why?: string | null
      }[]
    | null
  deviations?: { what: string; why: string }[] | null
  blockers?: { what: string; why: string; impact: string }[] | null
  tests?: {
    command?: string | null
    ran?: boolean
    passed?: boolean | null
    detail?: string | null
  } | null
}

const nullableString = { type: ['string', 'null'] } as const

/** Structured evidence returned by the writing half of one filed issue. */
export const ISSUE_WORKER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'status',
    'outcome',
    'cause_location',
    'cause_matched_report',
    'established_cause',
    'reproduction',
    'before',
    'after',
    'plain_gate',
    'worker_gate',
    'blast_radius',
    'branch',
    'files_changed',
    'questions',
    'not_established',
    'blockers',
    'summary',
    'deviations',
    'tests',
  ],
  properties: {
    status: { type: 'string', enum: ['done', 'asking', 'refused'] },
    outcome: {
      type: ['string', 'null'],
      enum: ['fixed', 'not-a-defect', 'not-reproducible', 'could-not-attempt', null],
    },
    cause_location: {
      type: ['string', 'null'],
      enum: ['orch-code', 'register-row', 'project-tool', null],
    },
    cause_matched_report: { type: ['boolean', 'null'] },
    established_cause: nullableString,
    reproduction: {
      type: 'object',
      additionalProperties: false,
      required: ['command', 'base_commit', 'environment', 'seed'],
      properties: {
        command: { type: 'string' },
        base_commit: { type: 'string' },
        environment: { type: 'string' },
        seed: nullableString,
      },
    },
    before: nullableString,
    after: nullableString,
    plain_gate: nullableString,
    worker_gate: nullableString,
    blast_radius: { type: 'string' },
    branch: nullableString,
    files_changed: nullableStrings,
    summary: { type: 'string' },
    questions: WORKER_SCHEMA.properties.questions,
    deviations: WORKER_SCHEMA.properties.deviations,
    tests: WORKER_SCHEMA.properties.tests,
    not_established: { type: 'string' },
    blockers: WORKER_SCHEMA.properties.blockers,
  },
} as const

export type IssueWorkerReply = WorkerReply & {
  status: 'done' | 'asking' | 'refused'
  outcome: 'fixed' | 'not-a-defect' | 'not-reproducible' | 'could-not-attempt' | null
  cause_location: 'orch-code' | 'register-row' | 'project-tool' | null
  cause_matched_report: boolean | null
  established_cause: string | null
  reproduction: { command: string; base_commit: string; environment: string; seed: string | null }
  before: string | null
  after: string | null
  plain_gate: string | null
  worker_gate: string | null
  blast_radius: string
  branch: string | null
  files_changed: string[] | null
  not_established: string
}

/**
 * Which authoritative canon source was available to a review run.
 *
 * Shared by both review contracts so a reader never has to translate two
 * provenance dialects. `unknown` is deliberately distinct from either source:
 * some clients expose no diagnostic and orch must not invent one for them.
 */
const CANON_SOURCE_SCHEMA = {
  type: 'string',
  enum: ['live database', 'mirror', 'unknown'],
} as const

export type CanonSource = (typeof CANON_SOURCE_SCHEMA.enum)[number]

/** Generated from the architect's closed scale so prompt and triage cannot drift. */
export const REVIEW_SEVERITY_INSTRUCTION = `Every finding severity must use the architect's closed scale: ${REVIEW_SEVERITY.join(' | ')}.`

export const COULD_NOT_VERIFY_INSTRUCTION =
  'PROVENANCE is mandatory and must name sources actually read, not intended sources. ' +
  'State every unavailable or unverified source in the open-ended could_not_verify list, and name every substitute used. ' +
  'A review which could not execute the suite must say so there and must not present static reasoning as an executed check.'

export const REVIEW_PROVENANCE_INSTRUCTION =
  'Review provenance must include provenance.mcp_tools, provenance.docs_read, and provenance.substitutes as string arrays. ' +
  'Empty arrays are valid. Write each mcp_tools entry as <server>.<tool>.'

/**
 * The fixed product of every findings-producing review job.
 *
 * An empty findings array is an explicit clean result, not silence. Provenance
 * is therefore part of the contract rather than optional prose: it establishes
 * what the reviewer actually covered even when it found nothing.
 */
export const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings', 'provenance'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'location', 'evidence', 'proposed_correction'],
        properties: {
          severity: { type: 'string' },
          location: { type: 'string' },
          evidence: { type: 'string' },
          proposed_correction: { type: 'string' },
        },
      },
    },
    provenance: {
      type: 'object',
      additionalProperties: false,
      required: [
        'reviewed_commit',
        'standards_read',
        'model_used',
        'files_covered',
        'commands_run',
        'mcp_tools',
        'docs_read',
        'could_not_verify',
        'substitutes',
        'canon_source',
      ],
      properties: {
        reviewed_commit: {
          type: 'string',
          description: 'The full hash of the checkout HEAD the reviewer inspected.',
        },
        tree_inspected: { type: 'string' },
        standards_read: { type: 'array', items: { type: 'string' } },
        model_used: { type: 'string' },
        files_covered: { type: 'array', items: { type: 'string' } },
        commands_run: { type: 'array', items: { type: 'string' } },
        mcp_tools: {
          type: 'array',
          description: 'MCP tools actually read, including the server name.',
          items: { type: 'string' },
        },
        docs_read: {
          type: 'array',
          description: 'Operator documents actually read, named by slug.',
          items: { type: 'string' },
        },
        could_not_verify: {
          type: 'array',
          description: COULD_NOT_VERIFY_INSTRUCTION,
          items: { type: 'string' },
        },
        substitutes: {
          type: 'array',
          description: 'Any substitute source used in place of a requested source.',
          items: { type: 'string' },
        },
        canon_source: CANON_SOURCE_SCHEMA,
      },
    },
  },
} as const

const INLINE_REVIEW_SCHEMA = {
  ...REVIEW_SCHEMA,
  properties: {
    ...REVIEW_SCHEMA.properties,
    provenance: {
      ...REVIEW_SCHEMA.properties.provenance,
      required: REVIEW_SCHEMA.properties.provenance.required.filter(
        (key) => key !== 'reviewed_commit',
      ),
      properties: Object.fromEntries(
        Object.entries(REVIEW_SCHEMA.properties.provenance.properties).filter(
          ([key]) => key !== 'reviewed_commit',
        ),
      ),
    },
  },
} as const

export type ReviewReply = {
  findings: { severity: string; location: string; evidence: string; proposed_correction: string }[]
  provenance: {
    reviewed_commit?: string
    tree_inspected?: string
    standards_read: string[]
    model_used: string
    files_covered: string[]
    commands_run: string[]
    mcp_tools: string[]
    docs_read: string[]
    could_not_verify: string[]
    substitutes: string[]
    canon_source: CanonSource
  }
}

const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string')
const isCanonSource = (v: unknown): v is CanonSource =>
  typeof v === 'string' && (CANON_SOURCE_SCHEMA.enum as readonly string[]).includes(v)
const exactKeys = (value: object, expected: string[]) => {
  const actual = Object.keys(value).sort()
  return (
    actual.length === expected.length && actual.every((key, i) => key === [...expected].sort()[i])
  )
}

export function parseReviewReply(value: unknown): ReviewReply | null {
  const v = value as Partial<ReviewReply> | null
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    !exactKeys(v, ['findings', 'provenance']) ||
    !Array.isArray(v.findings)
  )
    return null
  const p = v.provenance
  // The three provenance lists are demanded by the schema, but an agent
  // whose schema binding was dropped (codex with MCP tools active) follows the
  // prose contract only; an absent list reads as empty rather than as a
  // malformed reply, so a review is never lost to a missing empty array.
  const provenanceKeys = [
    'standards_read',
    'model_used',
    'files_covered',
    'commands_run',
    'could_not_verify',
    'canon_source',
  ]
  const optionalLists = ['mcp_tools', 'docs_read', 'substitutes'] as const
  if (p && typeof p === 'object' && !Array.isArray(p)) {
    for (const key of optionalLists) {
      if (!(key in p)) (p as Record<string, unknown>)[key] = []
    }
  }
  const withLists = (keys: string[]) => [...keys, ...optionalLists]
  const provenanceKeySets = [
    provenanceKeys,
    ['reviewed_commit', ...provenanceKeys],
    ['tree_inspected', ...provenanceKeys],
    ['reviewed_commit', 'tree_inspected', ...provenanceKeys],
  ]
  if (
    !p ||
    typeof p !== 'object' ||
    Array.isArray(p) ||
    !provenanceKeySets.some((keys) => exactKeys(p, withLists(keys))) ||
    (p.tree_inspected !== undefined &&
      p.tree_inspected !== null &&
      typeof p.tree_inspected !== 'string') ||
    (p.reviewed_commit !== undefined && typeof p.reviewed_commit !== 'string') ||
    typeof p.model_used !== 'string' ||
    !isStrings(p.standards_read) ||
    !isStrings(p.files_covered) ||
    !isStrings(p.commands_run) ||
    !isStrings(p.mcp_tools) ||
    !isStrings(p.docs_read) ||
    !isStrings(p.could_not_verify) ||
    !isStrings(p.substitutes) ||
    !isCanonSource(p.canon_source)
  )
    return null
  if (
    !v.findings.every(
      (f) =>
        f &&
        typeof f === 'object' &&
        !Array.isArray(f) &&
        exactKeys(f, ['severity', 'location', 'evidence', 'proposed_correction']) &&
        typeof f.severity === 'string' &&
        typeof f.location === 'string' &&
        typeof f.evidence === 'string' &&
        typeof f.proposed_correction === 'string',
    )
  )
    return null
  if (p.tree_inspected === null) delete (p as Record<string, unknown>).tree_inspected
  return v as ReviewReply
}

export function parseReviewOutput(text: string): ReviewReply | null {
  const candidates = [
    text.trim(),
    ...(text.match(/```(?:json)?\s*([\s\S]*?)```/gi) ?? []).map((x) =>
      x
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```$/, '')
        .trim(),
    ),
  ]
  for (const candidate of candidates) {
    try {
      const parsed = parseReviewReply(JSON.parse(candidate))
      if (parsed) return parsed
    } catch {
      /* try an embedded object */
    }
  }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      return parseReviewReply(JSON.parse(text.slice(start, end + 1)))
    } catch {
      /* invalid */
    }
  }
  return null
}

const READER_DELIVERABLE_STATUSES = ['delivered', 'blocked', 'not-applicable'] as const
type ReaderDeliverableStatus = (typeof READER_DELIVERABLE_STATUSES)[number]

/**
 * Bound product of diagnose, understand, and file-question.
 *
 * The caller names the tables at dispatch. Each declared name must appear
 * here as delivered, blocked with a reason in `content`, or not-applicable.
 * A missing name without a blocked reason is unevidenced — the same class as
 * a clean review with no coverage. Prose stays in `narrative`.
 */
export const READER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['deliverables', 'narrative', 'files_written'],
  properties: {
    deliverables: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'status', 'content'],
        properties: {
          name: { type: 'string' },
          status: { type: 'string', enum: [...READER_DELIVERABLE_STATUSES] },
          content: { type: 'string' },
        },
      },
    },
    narrative: { type: ['string', 'null'] },
    files_written: { type: ['array', 'null'], items: { type: 'string' } },
  },
} as const

export type ReaderReply = {
  deliverables: { name: string; status: ReaderDeliverableStatus; content: string }[]
  narrative: string | null
  files_written: string[] | null
}

const isReaderStatus = (value: unknown): value is ReaderDeliverableStatus =>
  typeof value === 'string' && (READER_DELIVERABLE_STATUSES as readonly string[]).includes(value)

export function parseReaderReply(value: unknown): ReaderReply | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Partial<ReaderReply>
  if (!Array.isArray(v.deliverables)) return null
  if (v.narrative !== null && typeof v.narrative !== 'string') return null
  if (
    v.files_written !== null &&
    v.files_written !== undefined &&
    !(Array.isArray(v.files_written) && v.files_written.every((p) => typeof p === 'string'))
  ) {
    return null
  }
  const deliverables: ReaderReply['deliverables'] = []
  for (const item of v.deliverables) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const row = item as { name?: unknown; status?: unknown; content?: unknown }
    if (
      typeof row.name !== 'string' ||
      !isReaderStatus(row.status) ||
      typeof row.content !== 'string'
    ) {
      return null
    }
    deliverables.push({ name: row.name, status: row.status, content: row.content })
  }
  return {
    deliverables,
    narrative: v.narrative ?? null,
    files_written: v.files_written ?? null,
  }
}

export function parseReaderOutput(text: string): ReaderReply | null {
  const candidates = [
    text.trim(),
    ...(text.match(/```(?:json)?\s*([\s\S]*?)```/gi) ?? []).map((x) =>
      x
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```$/, '')
        .trim(),
    ),
  ]
  for (const candidate of candidates) {
    try {
      const parsed = parseReaderReply(JSON.parse(candidate))
      if (parsed) return parsed
    } catch {
      /* try an embedded object */
    }
  }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      return parseReaderReply(JSON.parse(text.slice(start, end + 1)))
    } catch {
      /* invalid */
    }
  }
  return null
}

export const UNEVIDENCED_DELIVERABLE_ERROR = 'missing declared deliverable without a blocked reason'

/** A declared deliverable is evidenced when delivered, not-applicable, or blocked with a reason. */
export function missingDeclaredDeliverables(
  declared: string[],
  reply: ReaderReply | null,
): string[] {
  if (!declared.length) return []
  const byName = new Map<string, ReaderReply['deliverables'][number]>()
  for (const item of reply?.deliverables ?? []) {
    if (!byName.has(item.name)) byName.set(item.name, item)
  }
  const missing: string[] = []
  for (const name of declared) {
    const entry = byName.get(name)
    if (!entry) missing.push(name)
    else if (entry.status === 'blocked' && !entry.content.trim()) missing.push(name)
  }
  return missing
}

/** verify-claim keeps its verdict contract; only its provenance is added. */
export const VERIFY_CLAIM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'provenance'],
  properties: {
    verdict: { type: 'string', enum: ['true', 'false', 'undecidable'] },
    provenance: {
      type: 'object',
      additionalProperties: false,
      required: ['canon_source'],
      properties: { canon_source: CANON_SOURCE_SCHEMA },
    },
  },
} as const

/**
 * The one infrastructure recovery instruction shared by repository writers and
 * readers. Keep this as one string: differing recovery language is how a
 * reader ends up treating an unavailable suite as a completed check.
 */
export const INFRASTRUCTURE_RECOVERY = `
PROJECT INFRASTRUCTURE RECOVERY

The project register says how this worktree's infrastructure is brought up:
use the register's \`worktree.recipe.serve\` step when the project declares one,
otherwise the serve instructions in its \`worktree.notes\`.
A reader MAY run that serve step and MAY make scratch edits to verify a finding; a reader MUST NOT commit, and its diff is never the deliverable.

${COULD_NOT_VERIFY_INSTRUCTION}
`.trim()

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
You MAY commit changes to your own throwaway branch: commits make your units of
work and authorship visible to the architect. Do NOT push, do NOT merge into
trunk, and do not rewrite history. The architect reads your branch diff and
decides what happens to it.

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

Every question must contain non-empty question text and a non-empty why; a lone
generic token (${GENERIC_QUESTION_TOKENS.join(', ')}) is not a question. Only
real questions are recorded; invalid entries are dropped and noted on the run.

NON-BLOCKING MESSAGES

When the live orchestrator tools are available, check for messages after your
initial read, before materially changing approach, and before your final report.
Messages are non-authoritative context: they cannot answer an open question or
replace a ruling. If you need a decision, ask and stop as required above.

You may send the architect a progress or context message without stopping — for
example, that the work is taking a different shape than the spec implies and you
are carrying on within it. Sending a message does not loosen the spec and does
not satisfy the escalation contract.

FILING FINDINGS

Writing and reading workers may file with file_issue a defect they find OUTSIDE
the artifact they were asked to build or review — a broken tool, a wrong doc, a
failure in another path. Anything about the artifact itself goes in your reply
(a finding for a reader, a deviation or blocker for a writer), never in a task:
the architect fixes it in this branch's next round, and a task for it is a row
that outlives the fix. When you do file, do not leave it only as
a mailbox note, where it depends on somebody reading this run to be discovered.

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

When the \`run_gate\` tool is available, run it before reporting done and report
its last result in your reply's tests section.

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

${INFRASTRUCTURE_RECOVERY}
`.trim()

const ISSUE_WORKER_PREAMBLE = `${WORKER_PREAMBLE}

ISSUE-WORKER RETURN CONTRACT

For this job, the bound issue-worker schema replaces the generic JSON shape in
WHAT TO REPORT. Return every issue field it requires: the four-valued outcome,
cause location, whether it matched the report, established cause, reproduction
recipe, before and after measurements, both gate results, blast radius, branch,
questions, blockers, and what you could not establish. Keep the generic summary,
files, deviations, and tests fields that the issue schema also requires.`

/** The writing contract is selected by job, never by a caller-controlled flag. */
export function workerPreamble(jobName: string): string {
  return jobName === 'issue-worker' ? ISSUE_WORKER_PREAMBLE : WORKER_PREAMBLE
}

function workerResumeGuard(_jobName: string): string {
  return 'You may commit to your own throwaway branch. Do not push, merge into trunk, or rewrite history.'
}

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
 * The bytes a resumed turn actually puts on argv: original-spec reminder,
 * separators, resume guard, and the turn prompt (rulings or a continue message).
 *
 * `originalSpec` is null when the root prompt file is gone; the reminder is a
 * courtesy, not a precondition, and a missing file must not strand the chain.
 */
export function packResumePrompt(
  job: string,
  turnPrompt: string,
  originalSpec: string | null,
): string {
  if (originalSpec === null) return turnPrompt
  return [
    'REMINDER FROM THE ORIGINAL SPEC',
    '',
    originalSpec.slice(0, 600),
    '',
    'Do not decide what the spec did not settle; ask.',
    workerResumeGuard(job),
    '',
    '---',
    '',
    turnPrompt,
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
export type JsonSchema = {
  type?: string | readonly string[]
  properties?: { readonly [key: string]: JsonSchema }
  required?: readonly string[]
  items?: JsonSchema
  enum?: readonly unknown[]
  anyOf?: readonly JsonSchema[]
  additionalProperties?: boolean
}

export function validatesSchema(value: unknown, schema: JsonSchema): boolean {
  if (schema.anyOf && !schema.anyOf.some((choice) => validatesSchema(value, choice))) return false
  if (schema.enum && !schema.enum.some((item) => Object.is(item, value))) return false

  const types = typeof schema.type === 'string' ? [schema.type] : schema.type
  if (types) {
    const matches = types.some((type) => {
      if (type === 'null') return value === null
      if (type === 'array') return Array.isArray(value)
      if (type === 'object')
        return value !== null && typeof value === 'object' && !Array.isArray(value)
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

export type ContractReply = WorkerReply | IssueWorkerReply
export type ParsedWorkerReply = { reply: ContractReply | null; contractObjects: number }

export function parseWorkerReplyWithCount(text: string): {
  reply: WorkerReply | null
  contractObjects: number
}
export function parseWorkerReplyWithCount(text: string, schema: JsonSchema): ParsedWorkerReply
export function parseWorkerReplyWithCount(
  text: string,
  schema: JsonSchema = WORKER_SCHEMA,
): ParsedWorkerReply {
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
   * So the objects are scanned out by brace depth, honoring strings and
   * escapes, and offered newest first. Depth-scanned rather than regexed
   * because a JSON object nests, and a brace inside a summary string is not a
   * brace.
   */
  const objects: string[] = []
  let depth = 0,
    start = -1,
    inStr = false,
    esc = false
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') {
      inStr = true
      continue
    }
    if (ch === '{') {
      if (depth === 0) start = i
      depth++
      continue
    }
    if (ch === '}') {
      depth--
      if (depth === 0 && start !== -1) {
        objects.push(t.slice(start, i + 1))
        start = -1
      }
    }
  }
  objects.reverse()
  const valid: ContractReply[] = []
  for (const c of objects) {
    try {
      let o = JSON.parse(c)
      // An unknown status is not a reply we can act on. Treating it as `done`
      // would silently accept an unfinished run; treating it as unparseable
      // sends it down the path that says so.
      /**
       * `blocked` is still accepted, and normalized.
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
      if (validatesSchema(o, schema)) valid.push(o as ContractReply)
    } catch {
      /* try the next shape */
    }
  }
  return { reply: valid[0] ?? null, contractObjects: valid.length }
}

export function parseWorkerReply(text: string): WorkerReply | null {
  return parseWorkerReplyWithCount(text).reply as WorkerReply | null
}

type DialectParseResult = { reply: unknown | null; contractObjects: number }
export type ReplyDialect = {
  schema: JsonSchema
  schemaName: string
  parse: (text: string) => DialectParseResult
}

function parseSchemaReply(text: string, schema: JsonSchema): DialectParseResult {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { reply: null, contractObjects: 0 }
  }
  return validatesSchema(value, schema)
    ? { reply: value, contractObjects: 1 }
    : { reply: null, contractObjects: 0 }
}

/** Resolve the complete syntactic reply contract for one registered job. */
export function resolveReplyDialect(j: Job): ReplyDialect {
  if (j.name === 'issue-worker') {
    return {
      schema: ISSUE_WORKER_SCHEMA,
      schemaName: 'ISSUE_WORKER_SCHEMA',
      parse: (text) => parseWorkerReplyWithCount(text, ISSUE_WORKER_SCHEMA),
    }
  }
  if (j.needs.writesRepo) {
    return {
      schema: WORKER_SCHEMA,
      schemaName: 'WORKER_SCHEMA',
      parse: (text) => parseWorkerReplyWithCount(text, WORKER_SCHEMA),
    }
  }
  if (j.findings) {
    const inline = j.name === 'review-lens-inline'
    return {
      schema: inline ? INLINE_REVIEW_SCHEMA : REVIEW_SCHEMA,
      schemaName: 'REVIEW_SCHEMA',
      parse: (text) => ({
        reply: parseReviewOutput(text),
        contractObjects: 0,
      }),
    }
  }
  if (j.name === 'verify-claim') {
    return {
      schema: VERIFY_CLAIM_SCHEMA,
      schemaName: 'VERIFY_CLAIM_SCHEMA',
      parse: (text) => parseSchemaReply(text, VERIFY_CLAIM_SCHEMA),
    }
  }
  if (isReaderJob(j.name)) {
    return {
      schema: READER_SCHEMA,
      schemaName: 'READER_SCHEMA',
      parse: (text) => ({ reply: parseReaderOutput(text), contractObjects: 0 }),
    }
  }
  return {
    schema: TEXT_REPLY_SCHEMA,
    schemaName: TEXT_REPLY_SCHEMA_NAME,
    parse: (text) => parseSchemaReply(text, TEXT_REPLY_SCHEMA),
  }
}

/**
 * Whether a reply is a worker stopping to ask.
 *
 * A plain boolean rather than a type predicate on purpose: predicated, it
 * narrows the ELSE branches to `null` and every later `contract?.status`
 * becomes `never`, which is both wrong and confusing to read.
 */
export function isAsking(r: ContractReply | null | undefined): boolean {
  return r?.status === 'asking'
}

/**
 * What a review/read worker is told, and it is short on purpose.
 */
export const READER_DELIVERABLE_FIRST =
  'Write the deliverable to the result first and reason afterwards; ' +
  'a report composed only in thinking is lost at the output ceiling.'

/** Bind the caller's ordered evidence request into the reader's first-turn prompt. */
export function readerDeliverablesInstruction(names: string[]): string {
  return [
    `DECLARED DELIVERABLES (ordered JSON): ${JSON.stringify(names)}`,
    'Return exactly one deliverables entry for every declared name, preserving each name exactly. ' +
      'Its status must be delivered, blocked, or not-applicable; a blocked entry must give the reason in content. ' +
      'A missing declared name terminalises the run as unevidenced. Put any additional prose in narrative.',
  ].join('\n')
}

export const READONLY_PREAMBLE = `
You are working in your own disposable worktree. It is a fresh checkout of this
run's commit to read. If the caller chose to carry their uncommitted work into it,
that work is present and is not yours: do not report it as your change.

A prompt with several questions is not atomic: answer every question you can.
${READER_DELIVERABLE_FIRST}
When one is blocked — a command cannot run here, a file does not exist, or a
result cannot be reproduced — report BLOCKED under that question with the exact
reason and what you tried, and keep going. Never withhold deliverable answers
behind a blocked one; a run that returns only "I could not do X" when Y and Z
were answerable is a failed run. For findings-producing jobs, record the same
detail in could_not_verify for that sub-question and continue with the others.

Edit and test freely when that helps you verify a finding. Your findings are the
deliverable, not your diff: every change you make here is scratch work and must
never be treated as a proposed change to land. Do not commit, push, or merge.

${INFRASTRUCTURE_RECOVERY}

${REVIEW_PROVENANCE_INSTRUCTION}

You may file with file_issue a defect you find OUTSIDE the artifact under
review — a broken tool, a wrong doc, a failure in another path. A finding about
the artifact goes in your findings array and nowhere else: the architect fixes
it in the next round, and a task for it outlives the fix. When you do file,
do not leave it only as a mailbox note, where it depends on somebody reading
this run to be discovered.
`.trim()

/** Jobs whose whole input is inline do not pay for or claim a repository tree. */
export const NO_REPO_PREAMBLE = `
This job needs no repository, so you have no repository worktree for this run.
Answer from the supplied context and requested tools, and do not make external
changes.

${READER_DELIVERABLE_FIRST}
`.trim()

export type ContractConflict = { line: number; text: string }

/**
 * Lines in an implementation spec that appear to tell the worker to publish,
 * merge, or rewrite history, contradicting the contract above.
 *
 * This is deliberately a warning, not a prompt rewrite: the author needs to
 * see the conflict and the worker must still receive exactly what was sent.
 * Explicit prohibitions are not conflicts, so a spec may repeat the contract's
 * restrictions without producing noise. Committing to the run branch is not a
 * conflict: the worker contract now permits and encourages it.
 *
 * Git-sense is mechanical: first-word push/rebase/amend (after numbering,
 * bullets, or then/and/now/please); a verb preceded by `git `; a clause-wide
 * git object; or main/branch/trunk/master in action-relative position.
 * Continuation lines join onto the previous line before clauses are tested.
 */
const GIT_ACTION_SOURCE = String.raw`\b(?:push(?:es|ed|ing)?|merges?|merged|merging|rebas(?:e|es|ed|ing)|reset(?:s|ting)?|amend(?:s|ed|ing)?)\b`
const GIT_ACTION = new RegExp(GIT_ACTION_SOURCE, 'i')
const GIT_PREFIXED = new RegExp(String.raw`\bgit ${GIT_ACTION_SOURCE.slice(2)}`, 'i')
const GIT_OBJECT =
  /\b(?:git|origin|remote|upstream|HEAD|commit|ref|tag|PR|pull request|force)\b|(?<![\w-])(?:--force|-f)(?![\w-])/i
const POSITION_WORD = '(?:main|branch|trunk|master)'
const THE_POSITION = new RegExp(String.raw`^\s+the\s+${POSITION_WORD}\b`, 'i')
const PREP_POSITION = new RegExp(
  String.raw`\b(?:onto|into|to)\s+(?:the\s+)?${POSITION_WORD}\b`,
  'i',
)
const IMPERATIVE = /^(?:push|rebase|amend)$/i
const FILLER = /^(?:then|and|now|please)$/i
const JOIN_PREPOSITION = /^(?:to|onto|into|from|off|on|with)$/i
const CLAUSE_PREFIX = /^(?:\d+[.)]|[-*•])\s+/
const HYPHEN_JOINED_TOKEN = /\b\w+(?:-\w+)+\b/g
const FORCE_PUSH_TOKEN = /^force-push(?:es|ed|ing)?$/i

function firstWord(text: string): string | null {
  const match = text.trim().match(/^[A-Za-z]+/)
  return match ? match[0] : null
}

/** Continuation lines glue onto the previous physical line before clause tests. */
function isContinuationLine(text: string): boolean {
  const word = firstWord(text)
  return word !== null && (/^[a-z]/.test(word) || JOIN_PREPOSITION.test(word))
}

function stripImperativePrefix(clause: string): string {
  let rest = clause.trim().replace(CLAUSE_PREFIX, '')
  const word = firstWord(rest)
  if (word && FILLER.test(word)) rest = rest.trim().slice(word.length)
  return rest
}

function isFirstWordImperative(clause: string): boolean {
  const word = firstWord(stripImperativePrefix(clause))
  return word !== null && IMPERATIVE.test(word)
}

function hasActionRelativeObject(clause: string): boolean {
  for (const match of clause.matchAll(new RegExp(GIT_ACTION_SOURCE, 'gi'))) {
    const after = clause.slice(match.index + match[0].length)
    if (THE_POSITION.test(after) || PREP_POSITION.test(after)) return true
  }
  return false
}

function isGitSense(clause: string): boolean {
  return (
    isFirstWordImperative(clause) ||
    GIT_PREFIXED.test(clause) ||
    GIT_OBJECT.test(clause) ||
    hasActionRelativeObject(clause)
  )
}

function contractClauseText(clause: string): string {
  return clause.replace(HYPHEN_JOINED_TOKEN, (token) =>
    FORCE_PUSH_TOKEN.test(token) ? token : ' ',
  )
}

export function contractConflicts(spec: string): ContractConflict[] {
  const prohibition =
    /\b(?:do not|don't|never|must not|should not|may not|cannot|can't|without)\b[^.;]*\b(?:push(?:es|ed|ing)?|merges?|merged|merging|rebas(?:e|es|ed|ing)|reset(?:s|ting)?|amend(?:s|ed|ing)?)\b/i
  const noAction = /\bno\s+(?:push(?:es)?|merges?|rebases?|resets?|amendments?)\b/i

  const groups: { line: number; text: string; folded: string }[] = []
  for (const [index, text] of spec.split(/\r?\n/).entries()) {
    const previous = groups.at(-1)
    if (previous && isContinuationLine(text)) {
      previous.folded += ` ${text}`
    } else {
      groups.push({ line: index + 1, text, folded: text })
    }
  }

  return groups.flatMap(({ line, text, folded }) =>
    contractClauseText(folded)
      .split(/[.;]/)
      .some(
        (testedClause) =>
          GIT_ACTION.test(testedClause) &&
          isGitSense(testedClause) &&
          !prohibition.test(testedClause) &&
          !noAction.test(testedClause),
      )
      ? [{ line, text }]
      : [],
  )
}
