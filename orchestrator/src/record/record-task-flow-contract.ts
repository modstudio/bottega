// concern: hosted task-flow read contract
/** Validates the tenant-bound flow and open-stage read used by keyed workflow selection. */
import { z } from 'zod'

export const RECORD_TASK_FLOW_NOT_FOUND_MESSAGE = 'hosted task flow was not found'
export const TASK_FLOW_STAGE_LIST_LIMIT_MAX = 1_000
export const TASK_FLOW_STAGE_LIST_REMEDY = `Pass projectId, projectId with number, sessionId, one or more state values, or taskKey; limit must be from 1 through ${TASK_FLOW_STAGE_LIST_LIMIT_MAX}.`

const nullableId = z.string().uuid().nullable()
const machine = z.object({ id: z.string().uuid(), displayName: z.string().min(1) })
const stageState = z.enum(['running', 'awaiting-ruling', 'done', 'abandoned'])

const obligation = z.object({
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
const stepText = z.object({
  id: z.string().uuid(),
  stageRecordId: z.string().uuid(),
  stepOrdinal: z.number().int(),
  stepSlug: z.string(),
  body: z.string(),
  createdAt: z.string(),
})
const textCopy = z.object({
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
  obligations: z.array(obligation).optional(),
  stepTexts: z.array(stepText).optional(),
  textCopies: z.array(textCopy).optional(),
})

const hostedTaskFlowSummarySchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  taskId: z.string().uuid(),
  taskKey: z.string(),
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
export const hostedTaskFlowStageListSchema = z.object({
  items: z.array(
    z.object({ stage: hostedTaskFlowStageSummarySchema, flow: hostedTaskFlowSummarySchema }),
  ),
  truncated: z.boolean(),
})
export type HostedTaskFlowStageList = z.infer<typeof hostedTaskFlowStageListSchema>

export const taskFlowStageListQuerySchema = z
  .object({
    projectId: z.string().uuid().optional(),
    number: z.coerce.number().int().positive().optional(),
    sessionId: z.string().min(1).optional(),
    states: z.array(stageState).min(1).optional(),
    taskKey: z.string().min(1).optional(),
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
      value.taskKey === undefined
    )
      context.addIssue({ code: 'custom', message: 'at least one stage filter is required' })
  })
export type TaskFlowStageListQuery = z.infer<typeof taskFlowStageListQuerySchema>
