// concern: hosted-question-contract
/** Declares validated direct question commands and reads. */

import { z } from 'zod'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { RecordChangeCursor } from '../../../shared/record/record-changes.ts'

const id = z.string().uuid()
const stamp = z.string().datetime()
const nullableText = z.string().nullable()
const nullableId = id.nullable()

export const questionIntentSchema = z.enum([
  'ask',
  'answer',
  'close',
  'file',
  'link',
  'overturn',
  'relay',
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

export class RecordQuestionError extends Error {
  status: 404 | 409
  constructor(message: string, status: 404 | 409) {
    super(message)
    this.name = 'RecordQuestionError'
    this.status = status
  }
}

const questionChangedAfterLocalRefusal = {
  message: 'changedAfter is served only on a hosted install',
  remedy: `retry without changedAfter; local rulings polling uses \`${PLATFORM_SLUG} ruling list --changed-after\``,
} as const
export const questionChangedAfterRefusal = {
  message: 'changedAfter is served only for hosted rulings reads',
  remedy: 'retry this read without changedAfter, or use the rulings read for change-feed polling',
  local: questionChangedAfterLocalRefusal,
} as const

const readLimit = z.coerce.number().int().positive().max(100).optional()
const changedAfter = z.string().min(1).optional()
const questionIds = z.preprocess(
  (value) => (typeof value === 'string' ? value.split(',').filter(Boolean) : value),
  z.array(id).min(1).max(100),
)
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
  z.object({
    read: z.literal('by-id'),
    ids: questionIds,
    limit: readLimit,
    changedAfter,
  }),
  z.object({ read: z.literal('for-run'), runId: id, limit: readLimit, changedAfter }),
])
export type QuestionReadInput = z.infer<typeof questionReadSchema>
type RulingReadInput = Extract<QuestionReadInput, { read: 'rulings' }>
export type RecordQuestionReadInput =
  | Exclude<QuestionReadInput, RulingReadInput>
  | (Omit<RulingReadInput, 'changedAfter'> & { changedAfter?: RecordChangeCursor })
