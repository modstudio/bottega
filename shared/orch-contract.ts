import { z } from 'zod'
import { DOC_STATUSES } from './docs.ts'
import type { OperatorInboxKind } from './operator-inbox.ts'
import type { OperatorNotification } from './operator-notification-contract.ts'
import {
  ANSWER_CHANNEL_VALUES,
  ANSWERER_KIND_VALUES,
  ASKED_VIA_VALUES,
  QUESTION_DELIVERY_MODE_VALUES,
  QUESTION_DELIVERY_OUTCOME_VALUES,
} from './question-vocabulary.ts'
import {
  refuseHubActionOverrides,
  refuseNonCursorProjectId,
  trackerActionsShape,
  trackerReviewStagesShape,
  trackerSettingsShape,
} from './trackers.ts'

const DocSearchResultBaseSchema = z
  .object({
    scope: z.string(),
    subject: z.string().nullable(),
    slug: z.string(),
    title: z.string(),
    status: z.enum(DOC_STATUSES),
    headingPath: z.array(z.string()),
    snippet: z.string(),
    truncated: z.boolean(),
    embeddingScore: z.number().finite(),
    rerankScore: z.number().finite(),
  })
  .strict()

const DocSearchEnvelopeShape = {
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
}

export const RetrievalDocSearchOutputSchema = z
  .object({
    ...DocSearchEnvelopeShape,
    results: z.array(DocSearchResultBaseSchema),
  })
  .strict()

export const DocSearchOutputSchema = z
  .object({
    ...DocSearchEnvelopeShape,
    results: z.array(
      DocSearchResultBaseSchema.extend({
        summary: z.string(),
        summarySource: z.enum(['written', 'derived']),
      }).strict(),
    ),
  })
  .strict()

export type DocSearchOutput = z.infer<typeof DocSearchOutputSchema>
export type RetrievalDocSearchOutput = z.infer<typeof RetrievalDocSearchOutputSchema>

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

export const OperatorWaitingItemSchema = z
  .object({
    kind: z.enum(['question', 'workflow'] satisfies [OperatorInboxKind, ...OperatorInboxKind[]]),
    id: z.number().int().positive(),
    workflow_cursor_record_id: z.string().uuid().nullable(),
    question_record_id: z.string().uuid(),
    run_number: z.number().int().positive().nullable(),
    run_record_id: z.string().uuid().nullable(),
    project: z.string().nullable(),
    task_key: z.string().nullable(),
    session_id: z.string().nullable(),
    question: z.string(),
    options: z.array(z.string()),
    recommendation: z.string().nullable(),
    why: z.string().nullable(),
    waiting_since: z.string(),
    episode: z.string(),
    answer_command: z.string(),
  })
  .strict()

const OperatorNotificationSchema: z.ZodType<OperatorNotification> = z
  .object({ title: z.string(), body: z.string(), link: z.string() })
  .strict()

export const ClaimedOperatorNotificationSchema = OperatorWaitingItemSchema.extend({
  notification: OperatorNotificationSchema,
}).strict()

export const AnswerWaitingResultSchema = z
  .object({
    outcome: z.enum(['resumed', 'delivered-live', 'recorded']),
    run_record_id: z.string().uuid(),
    run_number: z.number().int().positive(),
    resumed_record_id: z.string().uuid().nullable(),
    resumed_number: z.number().int().positive().nullable(),
  })
  .strict()

const OpenQuestionSchema = z
  .object({
    question_id: z.number().int().positive(),
    question_record_id: z.string().uuid(),
    run_record_id: z.string().uuid(),
    run_number: z.number().int().positive(),
    answer_id: z.number().int().positive(),
    answer_record_id: z.string().uuid(),
    job: z.string(),
    agent: z.string(),
    repo: z.string().nullable(),
    asked_at: z.string(),
    session_live: z.literal(true).nullable(),
    session_liveness: z.enum(['live', 'unknown']),
    can_answer: z.boolean(),
    question: z.string(),
    options: z.array(z.string()),
    recommendation: z.string().nullable(),
    why: z.string().nullable(),
    status: z.string(),
    ruling_status: z.enum(['open', 'answered', 'overturned']),
    overturned_at: z.string().nullable(),
    overturned_by: z.string().nullable(),
    overturn_reason: z.string().nullable(),
    replacement: z.string().nullable(),
    filed_as: z.enum(['doc', 'canon-proposal']).nullable(),
    filed_ref: z.string().nullable(),
    filed_record_id: z.string().uuid().nullable(),
    filed_label: z.string().nullable(),
    filed_at: z.string().nullable(),
  })
  .strict()

export const ListOpenQuestionsResultSchema = z
  .object({
    questions: z.array(OpenQuestionSchema),
    waiting_on_operator: z.array(OperatorWaitingItemSchema),
  })
  .strict()

export const OverturnRulingResultSchema = z
  .object({
    question_id: z.number().int().positive(),
    record_id: z.string().uuid(),
    ruling_status: z.literal('overturned'),
    overturned_at: z.string(),
    overturned_by: z.string(),
    overturn_reason: z.string(),
    replacement: z.string().nullable(),
  })
  .strict()

export const FileRulingResultSchema = z
  .object({
    question_id: z.number().int().positive(),
    question_record_id: z.string().uuid(),
    filed_as: z.enum(['doc', 'canon-proposal']),
    filed_ref: z.string().min(1).nullable(),
    filed_record_id: z.string().uuid().nullable(),
    filed_label: z.string().min(1).nullable(),
    filed_at: z.string(),
  })
  .strict()

export type OperatorWaitingItem = z.infer<typeof OperatorWaitingItemSchema>
export type ClaimedOperatorNotification = z.infer<typeof ClaimedOperatorNotificationSchema>
export type AnswerWaitingResult = z.infer<typeof AnswerWaitingResultSchema>
export type ListOpenQuestionsResult = z.infer<typeof ListOpenQuestionsResultSchema>
export type FileRulingResult = z.infer<typeof FileRulingResultSchema>

// The published register is a read, so the tracker's two inner objects are
// loose here as well: a stage or an action a newer binary added must not take
// the whole register away from hub and retrieval. The shared shape keeps them
// strict for the register's writer.
const OrchTrackerSettingsSchema = z
  .looseObject({
    ...trackerSettingsShape,
    reviewStages: z.looseObject(trackerReviewStagesShape).optional(),
    actions: z.looseObject(trackerActionsShape).optional(),
  })
  .superRefine((tracker, context) => {
    refuseHubActionOverrides(tracker, context)
    refuseNonCursorProjectId(tracker, context)
  })

export const OrchProjectSchema = z
  .object({
    record_id: z.string().uuid(),
    name: z.string(),
    path: z.string(),
    stack: nullableString,
    canon: z.boolean(),
    repository: z.boolean(),
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
  .strip()

export const OrchProjectListSchema = z.array(OrchProjectSchema)

const OrchTurnSchema = z
  .object({
    number: z.number().int().positive(),
    record_id: z.string().uuid(),
    started_at: z.iso.datetime(),
    latency_ms: nullableNumber,
    vendor_tokens: nullableNumber,
    model_calls: nullableNumber.optional(),
    peak_call_tokens: nullableNumber.optional(),
    vendor_cost_usd: nullableNumber,
    cost_usd: nullableNumber.optional(),
    cost_source: nullableString.optional(),
    status: z.string(),
    turn: z.number().int().optional(),
  })
  .passthrough()

const OrchQuestionSchema = z
  .object({
    id: z.number().int(),
    record_id: z.string().uuid(),
    run_number: z.number().int(),
    run_record_id: z.string().uuid(),
    asked_at: z.iso.datetime(),
    answered_at: z.iso.datetime().nullable(),
    asked_via: z.enum(ASKED_VIA_VALUES).nullable(),
    answerer_kind: z.enum(ANSWERER_KIND_VALUES).nullable(),
    answer_channel: z.enum(ANSWER_CHANNEL_VALUES).nullable(),
    overturned_at: z.iso.datetime().nullable(),
    closed_at: z.iso.datetime().nullable().default(null),
    close_reason: nullableString.default(null),
    deliveries: z.array(
      z
        .object({
          id: z.number().int(),
          question_id: z.number().int(),
          question_record_id: z.string().uuid(),
          run_number: z.number().int().nullable(),
          run_record_id: z.string().uuid().nullable(),
          mode: z.enum(QUESTION_DELIVERY_MODE_VALUES),
          outcome: z.enum(QUESTION_DELIVERY_OUTCOME_VALUES),
          at: z.iso.datetime(),
          error: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .passthrough()

const RulingListRowSchema = z
  .object({
    id: z.number().int().positive(),
    record_id: z.string().uuid(),
    run_number: z.number().int().positive().nullable(),
    run_record_id: z.string().uuid().nullable(),
    workflow_cursor_id: z.string().uuid().nullable(),
    workflow_key: nullableString,
    project: nullableString,
    workflow_slug: nullableString,
    mode_slug: nullableString,
    session_id: nullableString,
    asked_at: z.string(),
    question: z.string(),
    answer: nullableString,
    answer_basis: nullableString,
    answered_at: nullableString,
    answered_by: nullableString,
    answered_by_name: nullableString.default(null),
    asked_via: z.enum(ASKED_VIA_VALUES).nullable(),
    answerer_kind: z.enum(ANSWERER_KIND_VALUES).nullable(),
    answer_channel: z.enum(ANSWER_CHANNEL_VALUES).nullable(),
    closed_at: nullableString,
    close_reason: nullableString,
    overturned_at: nullableString,
    overturned_by: nullableString,
    overturned_by_name: nullableString.default(null),
    overturn_reason: nullableString,
    replacement: nullableString,
    filed_as: nullableString,
    filed_ref: nullableString,
    filed_record_id: nullableString,
    filed_label: nullableString,
    filed_at: nullableString,
  })
  .strict()
export const RulingListSchema = z.array(RulingListRowSchema)
export type RulingListRow = z.infer<typeof RulingListRowSchema>

export const OrchRunSchema = z
  .object({
    number: z.number().int().positive(),
    record_id: z.string().uuid(),
    started_at: z.iso.datetime(),
    agent: z.string(),
    job: z.string(),
    repo: nullableString,
    cwd: nullableString,
    session_id: nullableString,
    started_by_user_id: nullableString.optional(),
    latency_ms: nullableNumber,
    vendor_tokens: nullableNumber,
    model_calls: nullableNumber.optional(),
    peak_call_tokens: nullableNumber.optional(),
    vendor_cost_usd: nullableNumber,
    cost_usd: nullableNumber.optional(),
    cost_source: nullableString.optional(),
    prompt_head: z.string(),
    prompt_path: nullableString.optional(),
    branch: nullableString.optional(),
    probe: z.number().int(),
    status: z.string(),
    delivery: nullableString.optional(),
    quality: nullableString.optional(),
    retry_record_id: z.string().uuid().nullable().optional(),
    turns: z.array(OrchTurnSchema).optional(),
    questions: z.array(OrchQuestionSchema),
    launch_key: nullableString.optional(),
    evidence_excluded: nullableString.optional(),
  })
  .passthrough()
  .superRefine((run, context) => {
    if ('retry_of' in run) {
      context.addIssue({
        code: 'custom',
        path: ['retry_of'],
        message: 'retry_of is retired; publish retry_record_id',
      })
    }
    const published = new Set((run.turns ?? []).map((turn) => turn.record_id))
    published.add(run.record_id)
    run.questions.forEach((question, index) => {
      if (!published.has(question.run_record_id)) {
        context.addIssue({
          code: 'custom',
          path: ['questions', index, 'run_record_id'],
          message: 'question owner is not present in the published run chain',
        })
      }
    })
  })

export const OrchUnknownRunSchema = z
  .object({
    number: z.number().int().positive().optional(),
    record_id: z.string().uuid().optional(),
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

const RunIdentitySchema = z
  .object({
    number: z.number().int().positive(),
    record_id: z.string().uuid(),
  })
  .strict()
export type RunIdentity = z.infer<typeof RunIdentitySchema>

const QuestionIdentitySchema = z
  .object({
    number: z.number().int().positive(),
    record_id: z.string().uuid(),
  })
  .strict()
export const QuestionIdentityListSchema = z.array(QuestionIdentitySchema)
export type QuestionIdentity = z.infer<typeof QuestionIdentitySchema>

const WorkflowCursorIdentityRowSchema = z
  .object({
    number: z.number().int().positive(),
    record_id: z.string().uuid(),
  })
  .strict()
export const WorkflowCursorIdentityRowListSchema = z.array(WorkflowCursorIdentityRowSchema)
export type WorkflowCursorIdentityRow = z.infer<typeof WorkflowCursorIdentityRowSchema>

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
          record_id: z.string().uuid(),
          root_id: z.number().int(),
          root_record_id: z.string().uuid(),
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

export const AttributionKindSchema = z.enum([
  'lock_holder',
  'landing',
  'tree_removal',
  'unattributed',
])
export const ConfinementClassSchema = z.enum([
  'overlapping',
  'non_overlapping',
  'edit_commit_cycle',
  'removed',
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
  throttles: z
    .array(
      z.object({
        concurrency: z.number().int().nonnegative(),
        throttles: z.number().int().nonnegative(),
      }),
    )
    .optional(),
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
          exampleRunRecordId: z.string().uuid(),
          exampleRunNumber: z.number().int(),
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
    record_id: z.string().uuid(),
    root_id: z.number().int(),
    root_record_id: z.string().uuid(),
    agent: z.string(),
    job: z.string(),
    project: nullableString,
    latency_ms: nullableNumber,
    vendor_tokens: nullableNumber,
    cost_usd: nullableNumber.optional(),
    cost_source: nullableString.optional(),
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
