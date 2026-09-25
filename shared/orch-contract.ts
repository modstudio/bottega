import { z } from 'zod'
import { refuseHubActionOverrides, trackerSettingsShape } from './trackers.ts'

export const DocSearchOutputSchema = z
  .object({
    query: z.string(),
    k: z.number().int(),
    contract: z
      .object({
        model: z.string(),
        dimension: z.number().int(),
        instructionVersion: z.string(),
      })
      .strict(),
    refresh: z
      .object({
        embedded: z.number().int(),
        deleted: z.number().int(),
        unchanged: z.number().int(),
        stale: z.number().int(),
      })
      .strict(),
    results: z.array(
      z
        .object({
          scope: z.string(),
          subject: z.string().nullable(),
          slug: z.string(),
          title: z.string(),
          headingPath: z.array(z.string()),
          snippet: z.string(),
          truncated: z.boolean(),
          embeddingScore: z.number().finite(),
          rerankScore: z.number().finite(),
        })
        .strict(),
    ),
  })
  .strict()

export type DocSearchOutput = z.infer<typeof DocSearchOutputSchema>

export const CodeSearchOutputSchema = z
  .object({
    query: z.string(),
    k: z.number().int(),
    contract: DocSearchOutputSchema.shape.contract,
    refresh: DocSearchOutputSchema.shape.refresh.extend({ pruned: z.number().int() }).strict(),
    results: z.array(
      z
        .object({
          project: z.string(),
          path: z.string(),
          startLine: z.number().int().positive(),
          endLine: z.number().int().positive(),
          snippet: z.string(),
          truncated: z.boolean(),
          embeddingScore: z.number().finite(),
          rerankScore: z.number().finite(),
        })
        .strict(),
    ),
  })
  .strict()

export type CodeSearchOutput = z.infer<typeof CodeSearchOutputSchema>

const nullableString = z.string().nullable()
const nullableNumber = z.number().finite().nullable()

const OrchTrackerSettingsSchema = z
  .looseObject(trackerSettingsShape)
  .superRefine(refuseHubActionOverrides)

export const OrchProjectSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    path: z.string(),
    stack: nullableString,
    canon: z.boolean(),
    settings: z
      .object({
        color: z.string().optional(),
        colorDark: z.string().optional(),
        envPrefix: z.string().optional(),
        keyPrefixes: z.array(z.string()).optional(),
        space: z.string().optional(),
        search: z.object({ code: z.boolean().optional() }).strict().optional(),
        tracker: OrchTrackerSettingsSchema.optional(),
      })
      .passthrough(),
  })
  .passthrough()

export const OrchProjectListSchema = z.array(OrchProjectSchema)

const OrchTurnSchema = z
  .object({
    id: z.number().int(),
    started_at: z.iso.datetime(),
    latency_ms: nullableNumber,
    vendor_tokens: nullableNumber,
    vendor_cost_usd: nullableNumber,
    status: z.string(),
    turn: z.number().int().optional(),
  })
  .passthrough()

const OrchQuestionSchema = z
  .object({
    id: z.number().int(),
    run_id: z.number().int(),
    asked_at: z.iso.datetime(),
    answered_at: z.iso.datetime().nullable(),
    asked_via: z.enum(['live', 'reply']).nullable(),
    answerer_kind: z.enum(['agent', 'operator', 'eval']).nullable(),
    answer_channel: z.enum(['cli', 'mcp', 'ui']).nullable(),
    deliveries: z.array(
      z
        .object({
          id: z.number().int(),
          question_id: z.number().int(),
          run_id: z.number().int().nullable(),
          mode: z.enum(['live', 'resume', 'retry', 'record-only']),
          outcome: z.enum(['delivered', 'failed']),
          at: z.iso.datetime(),
          error: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .passthrough()

export const OrchRunSchema = z
  .object({
    id: z.number().int(),
    started_at: z.iso.datetime(),
    agent: z.string(),
    job: z.string(),
    repo: nullableString,
    cwd: nullableString,
    session_id: nullableString,
    started_by_user_id: nullableString.optional(),
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
    evidence_excluded: nullableString.optional(),
  })
  .passthrough()
  .superRefine((run, context) => {
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

export const OrchUnknownRunSchema = z
  .object({
    id: z.number().int(),
    status: z.literal('unknown'),
    unknown: z.literal(true),
  })
  .strict()

const OrchRunLineDataSchema = z.union([OrchRunSchema, OrchUnknownRunSchema])

export const OrchRunEnvelopeSchema = z
  .object({
    schema_version: z.literal(2),
    kind: z.literal('run'),
    data: OrchRunLineDataSchema,
  })
  .strict()

const guideCandidate = z
  .object({
    agent: z.string(),
    score: nullableNumber,
    evidence: z.number(),
    latencyMs: nullableNumber,
  })
  .passthrough()
  .nullable()

export const OrchStateSchema = z
  .object({
    live: z.array(
      z
        .object({
          id: z.number().int(),
          agent: z.string(),
          job: z.string(),
          repo: nullableString,
          started_at: z.string(),
          prompt_head: z.string(),
        })
        .passthrough(),
    ),
    stale: z.number(),
    matrix: z.array(
      z
        .object({
          job: z.string(),
          promptBucket: z.enum(['small', 'large']),
          agent: z.string(),
          runs: z.number(),
          judged: z.number(),
          failures: z.number(),
          pts: z.number(),
          lat: nullableNumber,
          toks: nullableNumber,
        })
        .passthrough(),
    ),
    guide: z.array(
      z
        .object({
          job: z.string(),
          promptBucket: z.enum(['small', 'large']).nullable(),
          best: guideCandidate,
          quickest: guideCandidate,
          untried: z.array(z.string()),
          provisional: z.boolean().optional(),
        })
        .passthrough(),
    ),
    health: z.array(
      z
        .object({
          agent: z.string(),
          billing: z.string(),
          cooling: nullableString,
          lastStatus: nullableString,
          lastKind: nullableString,
          minsAgo: nullableNumber,
        })
        .passthrough(),
    ),
    totals: z
      .object({
        runs: z.number(),
        failed: z.number(),
        stale_n: z.number(),
        toks: z.number(),
        scored: z.number(),
        voided: z.number().optional(),
      })
      .passthrough(),
    unscored: z.number(),
    spawns: z.array(
      z.object({ decision: z.string(), why: z.string(), n: z.number() }).passthrough(),
    ),
    agents: z.array(
      z
        .object({
          name: z.string(),
          billing: z.string(),
          caps: z.object({ contextTokens: z.number().nullable().optional() }).catchall(z.boolean()),
        })
        .passthrough(),
    ),
    byRepo: z.array(
      z
        .object({
          repo: z.string(),
          agent: z.string(),
          runs: z.number(),
          toks: z.number(),
        })
        .passthrough(),
    ),
  })
  .passthrough()

export const OrchBlockersSchema = z
  .object({
    days: z.number().optional(),
    blockers: z.array(
      z
        .object({
          kind: nullableString,
          source: z.enum(['declared', 'detected']),
          runs: z.number(),
          projects: z.number(),
          agents: z.array(z.string()),
          lastAt: z.string().optional(),
          example: nullableString,
        })
        .passthrough(),
    ),
  })
  .passthrough()

export const OrchAgentDefinitionSchema = z.object({
  name: z.string(),
  caps: z.record(z.string(), z.boolean()),
  model: z.string(),
  operatedBy: z.enum(['vendor', 'self']),
  contextTokens: z.number().nullable(),
  maxPromptBytes: z.number().nullable(),
  timeoutMs: z.number(),
})

export const HostLoadSchema = z.object({
  gates: z.number(),
  loadavg: z.number(),
  ncpu: z.number(),
  freeMem: z.number(),
})

export const AttributionKindSchema = z.enum(['lock_holder', 'landing', 'unattributed'])
export const ConfinementClassSchema = z.enum([
  'overlapping',
  'non_overlapping',
  'edit_commit_cycle',
])
export type AttributionKind = z.infer<typeof AttributionKindSchema>
export type ConfinementClass = z.infer<typeof ConfinementClassSchema>

const AttributionCountsSchema = z.object(
  Object.fromEntries(
    AttributionKindSchema.options.map((kind) => [kind, z.number().int().nonnegative()]),
  ) as { [K in AttributionKind]: z.ZodNumber },
)

export function emptyAttribution(): Record<AttributionKind, number> {
  return Object.fromEntries(AttributionKindSchema.options.map((kind) => [kind, 0])) as Record<
    AttributionKind,
    number
  >
}

export const HarnessHealthSchema = z.object({
  header: z.string(),
  days: z.number().int().positive(),
  from: z.iso.datetime(),
  classes: z.array(
    z.object({
      kind: z.string(),
      count: z.number().int().nonnegative(),
      totalTimeMs: z.number().nonnegative(),
      meanTimeMs: z.number().nonnegative(),
      workPreserved: z.number().int().nonnegative(),
      reclaimedMs: z.number().nonnegative().optional(),
      firstSeen: nullableString,
      lastSeen: nullableString,
      clusters: z.array(
        z.object({
          text: z.string(),
          count: z.number().int().positive(),
          exampleRunId: z.number().int(),
        }),
      ),
      sparkline: z.array(
        z.object({
          day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          count: z.number().int().nonnegative(),
        }),
      ),
      attribution: AttributionCountsSchema.optional(),
    }),
  ),
  falseVerdicts: z.array(
    z.object({
      kind: z.string(),
      verdicts: z.number().int().nonnegative(),
      falseVerdicts: z.number().int().nonnegative(),
      rate: z.number().min(0).max(1),
    }),
  ),
  landingRefusals: z.number().int().nonnegative(),
  mcpProbeFailures: z.number().int().nonnegative(),
  mcpUnprobed: z.number().int().nonnegative(),
  mcpUnverifiedByAgent: z
    .array(
      z.object({
        agent: z.string(),
        count: z.number().int().nonnegative(),
      }),
    )
    .optional(),
  provenance: z
    .array(
      z.object({
        agent: z.string(),
        substituted: z.number().int().nonnegative(),
        silent: z.number().int().nonnegative(),
      }),
    )
    .optional(),
  flakes: z
    .array(
      z.object({
        test: z.string(),
        file: z.string(),
        count: z.number().int().nonnegative(),
        loadAtFailure: HostLoadSchema,
        signal: z.string().nullable(),
      }),
    )
    .optional(),
  contention: z.object({
    resources: z.array(
      z.object({
        kind: z.string(),
        count: z.number().int().nonnegative(),
        totalDurationMs: z.number().nonnegative(),
        meanDurationMs: z.number().nonnegative(),
        topKeys: z.array(
          z.object({
            key: z.string(),
            count: z.number().int().positive(),
          }),
        ),
      }),
    ),
    sessions: z.array(
      z.object({
        sessionId: z.string(),
        waitsSuffered: z.number().int().nonnegative(),
        invalidationsCaused: z.number().int().nonnegative(),
      }),
    ),
  }),
})

export const OrchRunDetailSchema = z
  .object({
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
    reviews: z.array(z.unknown()),
  })
  .passthrough()

export type OrchProject = z.infer<typeof OrchProjectSchema>
export type OrchRun = z.infer<typeof OrchRunSchema>
export type OrchTurn = z.infer<typeof OrchTurnSchema>
export type OrchUnknownRun = z.infer<typeof OrchUnknownRunSchema>
export type OrchRunLineData = z.infer<typeof OrchRunLineDataSchema>
export type OrchBlockers = z.infer<typeof OrchBlockersSchema>
export type HarnessHealth = z.infer<typeof HarnessHealthSchema>
export type OrchRunDetail = z.infer<typeof OrchRunDetailSchema>
