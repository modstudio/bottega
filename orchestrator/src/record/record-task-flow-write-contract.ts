// concern: hosted task-flow write contract
/** Declares the validated wire shapes for hosted task-flow command intents. */
import { z } from 'zod'

const id = z.string().uuid()
const stamp = z.string().datetime()
const revision = z.number().int().positive()
const nullableId = id.nullable()
const nullableText = z.string().nullable()

const flowInsert = z.object({
  id,
  projectId: id,
  taskId: id,
  state: z.enum(['open', 'done', 'dropped']),
  openStageRecordId: nullableId,
  openingMachineId: id,
  updatedMachineId: id,
  createdAt: stamp,
  updatedAt: stamp,
})

const stageInsert = z.object({
  id,
  flowRecordId: id,
  projectId: id,
  workflow: z.string(),
  mode: z.string(),
  workflowKey: z.string(),
  instanceId: z.string(),
  sessionId: nullableText,
  workflowVersionId: id,
  catalogueVersionId: id,
  arguments: z.record(z.string(), z.string()),
  activeOrdinal: z.number().int().nonnegative(),
  activeSlug: z.string(),
  state: z.enum(['running', 'awaiting-ruling', 'done', 'abandoned']),
  closedStepNotes: z.array(z.unknown()),
  question: nullableText,
  autonomy: nullableText,
  enforcement: z.string(),
  totalSteps: z.number().int().positive(),
  openedMachineId: id,
  takenOverFromMachineId: nullableId,
  lastAdvancedMachineId: id,
  createdAt: stamp,
  updatedAt: stamp,
})

const mutation = <T extends z.ZodRawShape>(values: z.ZodObject<T>) =>
  z.object({ id, expectedRevision: revision, values })

const flowComposeValues = z.object({
  state: z.enum(['open', 'done', 'dropped']).optional(),
  openStageRecordId: nullableId.optional(),
  openingMachineId: id.optional(),
  updatedMachineId: id,
  updatedAt: stamp,
})
const stageComposeValues = z.object({
  flowRecordId: id.optional(),
  instanceId: z.string().optional(),
  sessionId: nullableText.optional(),
  openedMachineId: id.optional(),
  takenOverFromMachineId: nullableId.optional(),
  lastAdvancedMachineId: id.optional(),
  updatedAt: stamp,
})
const stageUpdateValues = z.object({
  workflowKey: z.string().optional(),
  instanceId: z.string().optional(),
  sessionId: nullableText.optional(),
  arguments: z.record(z.string(), z.string()).optional(),
  activeOrdinal: z.number().int().nonnegative().optional(),
  activeSlug: z.string().optional(),
  state: z.enum(['running', 'awaiting-ruling', 'done', 'abandoned']).optional(),
  closedStepNotes: z.array(z.unknown()).optional(),
  question: nullableText.optional(),
  autonomy: nullableText.optional(),
  enforcement: z.string().optional(),
  takenOverFromMachineId: nullableId.optional(),
  lastAdvancedMachineId: id.optional(),
  updatedAt: stamp,
})
const flowCloseValues = z.object({
  state: z.enum(['open', 'done', 'dropped']).optional(),
  openStageRecordId: nullableId,
  updatedMachineId: id,
  updatedAt: stamp,
})

const obligationInsert = z.object({
  id,
  stageRecordId: id,
  stepOrdinal: z.number().int(),
  stepSlug: z.string(),
  floor: z.string(),
  requirePullRequest: z.boolean(),
  expectedExitCode: z.number().int(),
  expectedStatus: z.string(),
  floorDeferrable: z.boolean(),
  reason: z.string(),
  sessionId: nullableText,
  createdAt: stamp,
  satisfiedAt: stamp.nullable(),
  satisfiedStepOrdinal: z.number().int().nullable(),
  satisfiedStepSlug: nullableText,
  satisfiedEvidence: z.array(z.unknown()).nullable(),
  abandonedAt: stamp.nullable(),
  abandonedReason: nullableText,
  operatorRuling: z.boolean(),
})
const obligationUpdate = z.object({
  id,
  stageRecordId: id,
  satisfiedAt: stamp.nullable().optional(),
  satisfiedStepOrdinal: z.number().int().nullable().optional(),
  satisfiedStepSlug: nullableText.optional(),
  satisfiedEvidence: z.array(z.unknown()).nullable().optional(),
  abandonedAt: stamp.nullable().optional(),
  abandonedReason: nullableText.optional(),
})
const textInsert = z.object({
  id,
  stageRecordId: id,
  stepOrdinal: z.number().int(),
  stepSlug: z.string(),
  body: z.string(),
  createdAt: stamp,
})
const copyInsert = z.object({
  id,
  workflowTextRecordId: id,
  stageRecordId: id,
  taskDocumentReference: z.string(),
  copiedAt: stamp,
})

const base = { requestId: id }
export const taskFlowComposeSchema = z.object({
  ...base,
  flowInsert: flowInsert.optional(),
  flowChange: mutation(flowComposeValues).optional(),
  stageInsert: stageInsert.optional(),
  stageChanges: z.array(mutation(stageComposeValues)).default([]),
})
export const taskFlowStageUpdateSchema = z.object({
  ...base,
  stage: mutation(stageUpdateValues),
  flow: mutation(flowComposeValues).optional(),
})
export const taskFlowAdvanceSchema = z.object({
  ...base,
  stage: mutation(stageUpdateValues),
  flow: mutation(flowCloseValues).optional(),
  obligationInserts: z.array(obligationInsert).default([]),
  obligationUpdates: z.array(obligationUpdate).default([]),
})
export const taskFlowAwaitRulingSchema = z.object({
  ...base,
  stage: mutation(
    stageUpdateValues.pick({ arguments: true, closedStepNotes: true, state: true, question: true, sessionId: true, updatedAt: true }),
  ),
})
export const taskFlowAbandonSchema = z.object({
  ...base,
  stage: mutation(
    stageUpdateValues.pick({ state: true, closedStepNotes: true, question: true, sessionId: true, updatedAt: true }),
  ),
  flow: mutation(flowCloseValues).optional(),
  obligationUpdates: z.array(obligationUpdate).default([]),
})
export const taskFlowAttachTextSchema = z.object({ ...base, rows: z.array(textInsert).min(1) })
export const taskFlowDeleteTextSchema = z.object({ ...base, ids: z.array(id).min(1) })
export const taskFlowCopyTextSchema = z.object({ ...base, row: copyInsert })

export const taskFlowIntentSchemas = {
  compose: taskFlowComposeSchema,
  'stage-update': taskFlowStageUpdateSchema,
  advance: taskFlowAdvanceSchema,
  'await-ruling': taskFlowAwaitRulingSchema,
  abandon: taskFlowAbandonSchema,
  'attach-text': taskFlowAttachTextSchema,
  'delete-text': taskFlowDeleteTextSchema,
  'copy-text': taskFlowCopyTextSchema,
} as const

export type TaskFlowIntent = keyof typeof taskFlowIntentSchemas
export type TaskFlowIntentInput<K extends TaskFlowIntent> = z.infer<(typeof taskFlowIntentSchemas)[K]>
export const taskFlowWriteResultSchema = z.object({ revisions: z.record(id, revision) })
export type TaskFlowWriteResult = z.infer<typeof taskFlowWriteResultSchema>
