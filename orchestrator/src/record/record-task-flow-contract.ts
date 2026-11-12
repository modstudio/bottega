// concern: hosted task-flow read contract
/** Validates the tenant-bound flow and open-stage read used by keyed workflow selection. */
import { z } from 'zod'
import { decodeTaskFlowStageListCursor, type TaskFlowStageListCursor } from './record-cursor.ts'

export const RECORD_TASK_FLOW_NOT_FOUND_MESSAGE = 'hosted task flow was not found'
export const RECORD_TASK_FLOW_NOT_FOUND_CODE = 'task_flow_not_found'
export const TASK_FLOW_STAGE_LIST_LIMIT_MAX = 1_000
export const TASK_FLOW_PRESENCE_BATCH_MAX = 500
export const TASK_FLOW_STAGE_LIST_REMEDY = `Pass projectId, projectId with number, sessionId, states, taskKey, workflow, mode, workflowKey, keyless, primaryInstance, taskId, or unlinked; limit must be from 1 through ${TASK_FLOW_STAGE_LIST_LIMIT_MAX}. Restart the list without cursor when its cursor is invalid.`

const nullableId = z.string().uuid().nullable()
const machine = z.object({ id: z.string().uuid(), displayName: z.string().min(1) })
const stageState = z.enum(['running', 'awaiting-ruling', 'done', 'abandoned'])

const hostedTaskFlowObligationSchema = z.object({
  id: z.string().uuid(),
  stageRecordId: z.string().uuid(),
  stepOrdinal: z.number().int(),
  stepSlug: z.string(),
  floor: z.string(),
  requirePullRequest: z.boolean(),
  expectedExitCode: z.number().int(),
  expectedStatus: z.string(),
  floorDeferrable: z.boolean(),
  reason: z.string(),
  sessionId: z.string().nullable(),
  createdAt: z.string(),
  satisfiedAt: z.string().nullable(),
  satisfiedStepOrdinal: z.number().int().nullable(),
  satisfiedStepSlug: z.string().nullable(),
  satisfiedEvidence: z.array(z.unknown()).nullable(),
  abandonedAt: z.string().nullable(),
  abandonedReason: z.string().nullable(),
  operatorRuling: z.boolean(),
})
const hostedTaskFlowStepTextSchema = z.object({
  id: z.string().uuid(),
  stageRecordId: z.string().uuid(),
  stepOrdinal: z.number().int(),
  stepSlug: z.string(),
  body: z.string(),
  createdAt: z.string(),
})
const hostedTaskFlowTextCopySchema = z.object({
  id: z.string().uuid(),
  workflowTextRecordId: z.string().uuid(),
  stageRecordId: z.string().uuid(),
  taskDocumentReference: z.string(),
  copiedAt: z.string(),
})

const hostedTaskFlowStageSummarySchema = z.object({
  id: z.string().uuid(),
  flowRecordId: z.string().uuid(),
  projectId: z.string().uuid().nullable(),
  projectName: z.string().nullable(),
  number: z.number().int().positive().nullable(),
  workflow: z.string(),
  mode: z.string(),
  workflowKey: z.string().nullable().optional(),
  instanceId: z.string().nullable().optional(),
  sessionId: z.string().nullable().optional(),
  workflowVersionId: z.string().uuid(),
  workflowVersionNumber: z.number().int().positive().nullable(),
  catalogueVersionId: z.string().uuid(),
  catalogueVersionNumber: z.number().int().positive().nullable(),
  arguments: z.record(z.string(), z.string()),
  activeOrdinal: z.number().int().nonnegative(),
  activeSlug: z.string(),
  state: stageState,
  closedStepNotes: z.array(z.unknown()),
  question: z.string().nullable().optional(),
  autonomy: z.string().nullable().optional(),
  enforcement: z.string().nullable().optional(),
  totalSteps: z.number().int().positive(),
  openedMachineId: z.string().uuid(),
  takenOverFromMachineId: nullableId,
  lastAdvancedMachineId: z.string().uuid(),
  revision: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const hostedTaskFlowStageSchema = hostedTaskFlowStageSummarySchema.extend({
  obligations: z.array(hostedTaskFlowObligationSchema).optional(),
  stepTexts: z.array(hostedTaskFlowStepTextSchema).optional(),
  textCopies: z.array(hostedTaskFlowTextCopySchema).optional(),
})

const hostedTaskFlowSummarySchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  taskId: z.string().uuid().nullable(),
  taskKey: z.string().nullable(),
  state: z.enum(['open', 'done', 'dropped']),
  openStageRecordId: nullableId,
  openStageCount: z.number().int().nonnegative(),
  openingMachineId: z.string().uuid(),
  updatedMachineId: z.string().uuid(),
  revision: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const hostedTaskFlowSchema = z.object({
  flow: hostedTaskFlowSummarySchema,
  stage: hostedTaskFlowStageSchema.extend({ holder: machine }).nullable(),
  /** Every stage of the flow except the open stage. */
  otherStages: z.array(hostedTaskFlowStageSchema).optional(),
})

export type HostedTaskFlow = z.infer<typeof hostedTaskFlowSchema>
export const hostedTaskFlowStageByIdSchema = z.object({
  stage: hostedTaskFlowStageSchema,
  flow: hostedTaskFlowSummarySchema,
})
export type HostedTaskFlowStageById = z.infer<typeof hostedTaskFlowStageByIdSchema>

export const hostedTaskFlowTextByIdSchema = z.object({
  text: hostedTaskFlowStepTextSchema,
  stage: z.object({ id: z.string().uuid(), number: z.number().int().positive().nullable() }),
  copy: hostedTaskFlowTextCopySchema.nullable(),
})
export type HostedTaskFlowTextById = z.infer<typeof hostedTaskFlowTextByIdSchema>

export const hostedTaskFlowObligationByIdSchema = z.object({
  obligation: hostedTaskFlowObligationSchema,
  stage: z.object({
    id: z.string().uuid(),
    number: z.number().int().positive().nullable(),
    state: stageState,
  }),
})
export type HostedTaskFlowObligationById = z.infer<typeof hostedTaskFlowObligationByIdSchema>

export const hostedTaskFlowStageListSchema = z
  .object({
    items: z.array(
      z.object({ stage: hostedTaskFlowStageSummarySchema, flow: hostedTaskFlowSummarySchema }),
    ),
    truncated: z.boolean(),
    nextCursor: z.string().nullable(),
  })
  .refine((value) => value.truncated === (value.nextCursor !== null), {
    message: 'nextCursor must be present exactly when the stage list is truncated',
  })
export type HostedTaskFlowStageList = z.infer<typeof hostedTaskFlowStageListSchema>

export const hostedTaskFlowProjectReferenceCountsSchema = z.object({
  stages: z.number().int().nonnegative(),
  flows: z.number().int().nonnegative(),
})
export type HostedTaskFlowProjectReferenceCounts = z.infer<
  typeof hostedTaskFlowProjectReferenceCountsSchema
>

export const taskFlowPresenceInputSchema = z.object({
  stageIds: z.array(z.string().uuid()).max(TASK_FLOW_PRESENCE_BATCH_MAX),
  flowIds: z.array(z.string().uuid()).max(TASK_FLOW_PRESENCE_BATCH_MAX),
})
export type TaskFlowPresenceInput = z.infer<typeof taskFlowPresenceInputSchema>
export const taskFlowPresenceSchema = taskFlowPresenceInputSchema
export type TaskFlowPresence = z.infer<typeof taskFlowPresenceSchema>

export const taskFlowReadQuerySchema = z
  .object({
    taskKey: z.string().min(1).optional(),
    flowRecordId: z.string().uuid().optional(),
    taskId: z.string().uuid().optional(),
  })
  .refine(
    (value) =>
      Number(Boolean(value.taskKey)) +
        Number(Boolean(value.flowRecordId)) +
        Number(Boolean(value.taskId)) ===
      1,
  )
export type TaskFlowReadQueryInput = z.input<typeof taskFlowReadQuerySchema>

const trueFlag = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => (value === 'true' ? true : undefined))

const taskFlowStageListCursor = z
  .string()
  .min(1)
  .transform((value, context): TaskFlowStageListCursor => {
    try {
      return decodeTaskFlowStageListCursor(value)
    } catch {
      context.addIssue({ code: 'custom', message: 'invalid stage-list cursor' })
      return z.NEVER
    }
  })

export const taskFlowStageListQuerySchema = z
  .object({
    projectId: z.string().uuid().optional(),
    number: z.coerce.number().int().positive().optional(),
    sessionId: z.string().min(1).optional(),
    states: z.array(stageState).min(1).optional(),
    taskKey: z.string().min(1).optional(),
    workflow: z.string().min(1).optional(),
    mode: z.string().min(1).optional(),
    workflowKey: z.string().min(1).optional(),
    keyless: trueFlag,
    primaryInstance: trueFlag,
    taskId: z.string().uuid().optional(),
    unlinked: trueFlag,
    order: z.enum(['project', 'newest']).default('project'),
    cursor: taskFlowStageListCursor.optional(),
    limit: z.coerce.number().int().min(1).max(TASK_FLOW_STAGE_LIST_LIMIT_MAX).default(200),
  })
  .superRefine((value, context) => {
    if (value.number !== undefined && value.projectId === undefined)
      context.addIssue({
        code: 'custom',
        message: 'stage number requires projectId',
        path: ['number'],
      })
    if (
      value.projectId === undefined &&
      value.number === undefined &&
      value.sessionId === undefined &&
      value.states === undefined &&
      value.taskKey === undefined &&
      value.workflow === undefined &&
      value.mode === undefined &&
      value.workflowKey === undefined &&
      value.keyless === undefined &&
      value.primaryInstance === undefined &&
      value.taskId === undefined &&
      value.unlinked === undefined
    )
      context.addIssue({ code: 'custom', message: 'at least one stage filter is required' })
    if (value.cursor !== undefined) {
      if (value.cursor.order !== value.order)
        context.addIssue({
          code: 'custom',
          message: 'cursor order does not match request order',
          path: ['cursor'],
        })
    }
  })
export type TaskFlowStageListQuery = z.infer<typeof taskFlowStageListQuerySchema>
export type TaskFlowStageListQueryInput = z.input<typeof taskFlowStageListQuerySchema>
