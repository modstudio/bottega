// concern: hosted-question-contract
/** Declares validated direct question commands and reads. */

import { z } from 'zod'

const id = z.string().uuid()
const stamp = z.string().datetime()
const nullableText = z.string().nullable()
const nullableId = id.nullable()

export const questionIntentSchema = z.enum([
  'ask',
  'answer',
  'close',
  'link',
  'overturn',
  'abandon',
])
export type QuestionIntent = z.infer<typeof questionIntentSchema>

const questionAuditSchema = z.object({
  action: z.string().min(1),
  actorSession: nullableText,
  at: stamp,
  reason: nullableText,
})

const questionSnapshotSchema = z.object({
  id,
  number: z.number().int().positive().nullable().default(null),
  runId: nullableId,
  workflowKey: nullableText,
  workflowTaskId: nullableId,
  workflowCursorRecordId: nullableId,
  projectId: nullableId,
  machineId: id,
  revision: z.number().int().positive(),
  askedAt: stamp,
  question: z.string(),
  options: z.unknown().nullable(),
  recommendation: nullableText,
  why: nullableText,
  askedVia: nullableText,
  kind: nullableText,
  typedOptions: z.unknown().nullable(),
  criteria: z.unknown().nullable(),
  levels: z.unknown().nullable(),
  answer: nullableText,
  answerValue: nullableText,
  answerBasis: nullableText,
  answeredAt: stamp.nullable(),
  answeredBy: nullableText,
  answeredByName: nullableText,
  answeredByKind: nullableText,
  answererKind: nullableText,
  answerChannel: nullableText,
  jevPick: nullableText,
  jevConfidence: z.number().nullable(),
  jevProbabilities: z.unknown().nullable(),
  jevModel: nullableText,
  jevInputTokens: z.number().int().nullable(),
  jevError: nullableText,
  jevAgreed: z.number().int().nullable(),
  jevQuestionVersion: z.number().int().nullable(),
  jevFits: z.number().nullable(),
  jevOrderFlipped: z.number().int().nullable(),
  awaitingOperatorAt: stamp.nullable(),
  relayedBy: nullableText,
  overturnedAt: stamp.nullable(),
  overturnedBy: nullableText,
  overturnedByName: nullableText,
  overturnReason: nullableText,
  replacement: nullableText,
  filedAs: nullableText,
  filedRef: nullableText,
  filedRecordId: nullableId,
  filedLabel: nullableText,
  filedAt: stamp.nullable(),
  closedAt: stamp.nullable(),
  closeReason: nullableText,
  withheldFields: z.array(z.string()).default([]),
  createdAt: stamp,
  updatedAt: stamp,
})

export const questionWriteSchema = z.object({
  requestId: id,
  question: questionSnapshotSchema,
  audit: questionAuditSchema,
})
export type QuestionWriteBody = z.infer<typeof questionWriteSchema>
export const questionWriteResultSchema = z.object({
  id,
  number: z.number().int().positive(),
  revision: z.number().int().positive(),
})
export type QuestionWriteResult = z.infer<typeof questionWriteResultSchema>

const readLimit = z.coerce.number().int().positive().max(100).optional()
const changedAfter = z.coerce.number().int().nonnegative().optional()
export const questionReadSchema = z.discriminatedUnion('read', [
  z.object({ read: z.literal('inbox'), limit: readLimit, changedAfter }),
  z.object({ read: z.literal('waiting'), limit: readLimit, changedAfter }),
  z.object({
    read: z.literal('open-for-session'),
    sessionId: z.string().min(1, 'sessionId is required'),
    limit: readLimit,
    changedAfter,
  }),
  z.object({
    read: z.literal('rulings'),
    kind: z.enum(['workflow', 'run', 'all']).default('all'),
    since: stamp.optional(),
    limit: readLimit,
    changedAfter,
  }),
  z.object({
    read: z.literal('task-rulings'),
    projectId: id,
    taskId: id,
    limit: readLimit,
    changedAfter,
  }),
  z.object({ read: z.literal('projects'), limit: readLimit, changedAfter }),
])
export type QuestionReadInput = z.infer<typeof questionReadSchema>
