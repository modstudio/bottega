import { z } from 'zod'

const nullableString = z.string().nullable()
const nullableNumber = z.number().finite().nullable()

export const OrchTrackerSettingsSchema = z.object({
  kind: z.string().optional(),
  protocol: z.string().optional(),
  assigneeLookup: z.enum(['person-lookup', 'task-detail']).optional(),
  envPrefix: z.string().optional(),
  openStatuses: z.array(z.string()).optional(),
  states: z.record(z.string(), z.enum(['backlog', 'open', 'active', 'review', 'done', 'dropped'])).optional(),
}).passthrough()

export const OrchProjectSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  path: z.string(),
  stack: nullableString,
  canon: z.boolean(),
  settings: z.object({
    color: z.string().optional(),
    colorDark: z.string().optional(),
    envPrefix: z.string().optional(),
    keyPrefixes: z.array(z.string()).optional(),
    tracker: OrchTrackerSettingsSchema.optional(),
  }).passthrough(),
}).passthrough()

export const OrchProjectListSchema = z.array(OrchProjectSchema)

export const OrchTurnSchema = z.object({
  id: z.number().int(),
  started_at: z.iso.datetime(),
  latency_ms: nullableNumber,
  vendor_tokens: nullableNumber,
  vendor_cost_usd: nullableNumber,
  status: z.string(),
  turn: z.number().int().optional(),
}).passthrough()

export const OrchQuestionSchema = z.object({
  id: z.number().int(),
  run_id: z.number().int(),
  asked_at: z.iso.datetime(),
  answered_at: z.iso.datetime().nullable(),
}).passthrough()

export const OrchRunSchema = z.object({
  id: z.number().int(),
  started_at: z.iso.datetime(),
  agent: z.string(),
  job: z.string(),
  repo: nullableString,
  cwd: nullableString,
  session_id: nullableString,
  latency_ms: nullableNumber,
  vendor_tokens: nullableNumber,
  vendor_cost_usd: nullableNumber,
  prompt_head: z.string(),
  prompt_path: nullableString.optional(),
  branch: nullableString.optional(),
  probe: z.number().int(),
  status: z.string(),
  delivery: nullableString.optional(),
  quality: nullableString.optional(),
  retry_of: z.number().int().nullable().optional(),
  turns: z.array(OrchTurnSchema).optional(),
  questions: z.array(OrchQuestionSchema),
  launch_key: nullableString.optional(),
}).passthrough().superRefine((run, context) => {
  const published = new Set((run.turns ?? []).map((turn) => turn.id))
  published.add(run.id)
  run.questions.forEach((question, index) => {
    if (!published.has(question.run_id)) {
      context.addIssue({
        code: 'custom',
        path: ['questions', index, 'run_id'],
        message: 'question owner is not present in the published run chain',
      })
    }
  })
})

export const OrchUnknownRunSchema = z.object({
  id: z.number().int(),
  status: z.literal('unknown'),
  unknown: z.literal(true),
}).strict()

export const OrchRunLineDataSchema = z.union([OrchRunSchema, OrchUnknownRunSchema])

export const OrchRunEnvelopeSchema = z.object({
  schema_version: z.literal(2),
  kind: z.literal('run'),
  data: OrchRunLineDataSchema,
}).strict()

export function encodeOrchRunLine(value: unknown, version: 1 | 2 = 2): string {
  const data = OrchRunLineDataSchema.parse(value)
  return JSON.stringify(version === 1 ? data : { schema_version: 2, kind: 'run', data })
}

const guideCandidate = z.object({
  agent: z.string(), score: nullableNumber, evidence: z.number(), latencyMs: nullableNumber,
}).passthrough().nullable()

export const OrchStateSchema = z.object({
  live: z.array(z.object({
    id: z.number().int(), agent: z.string(), job: z.string(), repo: nullableString,
    started_at: z.string(), prompt_head: z.string(),
  }).passthrough()),
  stale: z.number(),
  matrix: z.array(z.object({
    job: z.string(), promptBucket: z.enum(['small', 'large']), agent: z.string(),
    runs: z.number(), judged: z.number(), failures: z.number(), pts: z.number(),
    lat: nullableNumber, toks: nullableNumber,
  }).passthrough()),
  guide: z.array(z.object({
    job: z.string(), promptBucket: z.enum(['small', 'large']).nullable(),
    best: guideCandidate, quickest: guideCandidate, untried: z.array(z.string()),
    provisional: z.boolean().optional(),
  }).passthrough()),
  health: z.array(z.object({
    agent: z.string(), billing: z.string(), cooling: nullableNumber,
    lastStatus: nullableString, lastKind: nullableString, minsAgo: nullableNumber,
  }).passthrough()),
  totals: z.object({
    runs: z.number(), failed: z.number(), stale_n: z.number(), toks: z.number(), scored: z.number(),
  }).passthrough(),
  unscored: z.number(),
  spawns: z.array(z.object({ decision: z.string(), why: z.string(), n: z.number() }).passthrough()),
  agents: z.array(z.object({
    name: z.string(), billing: z.string(), caps: z.record(z.string(), z.boolean()),
  }).passthrough()),
  byRepo: z.array(z.object({
    repo: z.string(), agent: z.string(), runs: z.number(), toks: z.number(),
  }).passthrough()),
}).passthrough()

export const OrchBlockersSchema = z.object({
  days: z.number().optional(),
  blockers: z.array(z.object({
    kind: nullableString,
    source: z.enum(['declared', 'detected']),
    runs: z.number(),
    projects: z.number(),
    agents: z.array(z.string()),
    lastAt: z.string().optional(),
    example: nullableString,
  }).passthrough()),
}).passthrough()

export const HarnessHealthSchema = z.object({
  header: z.string(),
  days: z.number().int().positive(),
  from: z.iso.datetime(),
  classes: z.array(z.object({
    kind: z.string(),
    count: z.number().int().nonnegative(),
    totalTimeMs: z.number().nonnegative(),
    meanTimeMs: z.number().nonnegative(),
    firstSeen: nullableString,
    lastSeen: nullableString,
    clusters: z.array(z.object({
      text: z.string(), count: z.number().int().positive(), exampleRunId: z.number().int(),
    })),
    sparkline: z.array(z.object({
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), count: z.number().int().nonnegative(),
    })),
  })),
  falseVerdicts: z.array(z.object({
    kind: z.string(), verdicts: z.number().int().nonnegative(),
    falseVerdicts: z.number().int().nonnegative(), rate: z.number().min(0).max(1),
  })),
  landingRefusals: z.number().int().nonnegative(),
})

export const OrchRunDetailSchema = z.object({
  id: z.number().int(),
  agent: z.string(),
  job: z.string(),
  project: nullableString,
  latency_ms: nullableNumber,
  vendor_tokens: nullableNumber,
  status: z.string(),
  failure_kind: nullableString,
  probe: z.union([z.boolean(), z.number()]),
  evidence_excluded: nullableString,
  error: nullableString,
  prompt: nullableString,
  output: nullableString,
  delivery: nullableString,
  quality: nullableString,
  fidelity: nullableString,
  note: nullableString,
  scored_at: nullableString,
  scoreAxes: z.array(z.enum(['delivery', 'quality', 'fidelity'])),
}).passthrough()

export type OrchProject = z.infer<typeof OrchProjectSchema>
export type OrchRun = z.infer<typeof OrchRunSchema>
export type OrchTurn = z.infer<typeof OrchTurnSchema>
export type OrchQuestion = z.infer<typeof OrchQuestionSchema>
export type OrchUnknownRun = z.infer<typeof OrchUnknownRunSchema>
export type OrchRunLineData = z.infer<typeof OrchRunLineDataSchema>
export type OrchRunEnvelope = z.infer<typeof OrchRunEnvelopeSchema>
export type OrchState = z.infer<typeof OrchStateSchema>
export type OrchBlockers = z.infer<typeof OrchBlockersSchema>
export type HarnessHealth = z.infer<typeof HarnessHealthSchema>
export type OrchRunDetail = z.infer<typeof OrchRunDetailSchema>
