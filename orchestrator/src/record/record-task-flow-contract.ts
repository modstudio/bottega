// concern: hosted task-flow read contract
/** Validates the tenant-bound flow and open-stage read used by keyed workflow selection. */
import { z } from 'zod'

export const RECORD_TASK_FLOW_NOT_FOUND_MESSAGE = 'hosted task flow was not found'

const nullableId = z.string().uuid().nullable()
const machine = z.object({ id: z.string().uuid(), displayName: z.string().min(1) })

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

const hostedTaskFlowStageSchema = z.object({
  id: z.string().uuid(),
  flowRecordId: z.string().uuid(),
  projectId: z.string().uuid().nullable().optional(),
  number: z.number().int().positive().nullable().optional(),
  workflow: z.string(),
  mode: z.string(),
  workflowKey: z.string().nullable().optional(),
  instanceId: z.string().nullable().optional(),
  sessionId: z.string().nullable().optional(),
  workflowVersionId: z.string().uuid(),
  catalogueVersionId: z.string().uuid(),
  arguments: z.record(z.string(), z.string()),
  activeOrdinal: z.number().int().nonnegative(),
  activeSlug: z.string(),
  state: z.enum(['running', 'awaiting-ruling', 'done', 'abandoned']),
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
  obligations: z.array(obligation).optional(),
  stepTexts: z.array(stepText).optional(),
  textCopies: z.array(textCopy).optional(),
})

export const hostedTaskFlowSchema = z.object({
  flow: z.object({
    id: z.string().uuid(),
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
    state: z.enum(['open', 'done', 'dropped']),
    openStageRecordId: nullableId,
    openingMachineId: z.string().uuid(),
    updatedMachineId: z.string().uuid(),
    revision: z.number().int().positive(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
  stage: hostedTaskFlowStageSchema.extend({ holder: machine }).nullable(),
  /** Every stage of the flow except the open stage. */
  otherStages: z.array(hostedTaskFlowStageSchema).optional(),
})

export type HostedTaskFlow = z.infer<typeof hostedTaskFlowSchema>
