// concern: hosted task-flow read contract
/** Validates the tenant-bound flow and open-stage read used by keyed workflow selection. */
import { z } from 'zod'

export const RECORD_TASK_FLOW_NOT_FOUND_MESSAGE = 'hosted task flow was not found'

const nullableId = z.string().uuid().nullable()
const machine = z.object({ id: z.string().uuid(), displayName: z.string().min(1) })

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
  stage: z
    .object({
      id: z.string().uuid(),
      flowRecordId: z.string().uuid(),
      workflow: z.string(),
      mode: z.string(),
      workflowVersionId: z.string().uuid(),
      catalogueVersionId: z.string().uuid(),
      arguments: z.record(z.string(), z.string()),
      activeOrdinal: z.number().int().nonnegative(),
      activeSlug: z.string(),
      state: z.enum(['running', 'awaiting-ruling', 'done', 'abandoned']),
      closedStepNotes: z.array(z.unknown()),
      totalSteps: z.number().int().positive(),
      openedMachineId: z.string().uuid(),
      takenOverFromMachineId: nullableId,
      lastAdvancedMachineId: z.string().uuid(),
      revision: z.number().int().positive(),
      createdAt: z.string(),
      updatedAt: z.string(),
      holder: machine,
    })
    .nullable(),
})

export type HostedTaskFlow = z.infer<typeof hostedTaskFlowSchema>
