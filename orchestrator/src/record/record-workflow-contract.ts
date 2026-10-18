// concern: record-workflow-contract
/** Pure transport contract for the hosted workflow catalogue. */
import { z } from 'zod'

export const RECORD_WORKFLOW_TABLES = [
  'step_catalogue',
  'step_catalogue_version',
  'step_catalogue_event',
  'workflow',
  'workflow_version',
  'workflow_event',
] as const
export type RecordWorkflowTable = (typeof RECORD_WORKFLOW_TABLES)[number]
export type RecordWorkflowKind = 'workflow' | 'step_catalogue'

export class RecordWorkflowError extends Error {
  readonly status: number
  constructor(message: string, status = 409) {
    super(message)
    this.status = status
  }
}

const uuid = z.string().uuid(), iso = z.string().datetime({ offset: true })
const identity = z.object({ id: uuid, spaceId: uuid, slug: z.string().min(1), createdAt: iso, updatedAt: iso })
const version = z.object({
  id: uuid, spaceId: uuid, ownerId: uuid, n: z.number().int().positive(),
  status: z.enum(['draft', 'production', 'retired']), definition: z.string(),
  author: z.string().min(1), reason: z.string().min(1), createdAt: iso,
  promotedAt: iso.nullable(), retiredAt: iso.nullable(), updatedAt: iso,
})
const event = z.object({
  id: uuid, spaceId: uuid, ownerVersionId: uuid,
  event: z.enum(['set', 'fork', 'import', 'promote', 'retire']),
  author: z.string().min(1), reason: z.string().min(1), sessionId: z.string().nullable(), at: iso,
})
const rows = {
  step_catalogue: identity,
  step_catalogue_version: version,
  step_catalogue_event: event,
  workflow: identity,
  workflow_version: version,
  workflow_event: event,
} as const
export const recordWorkflowTableSchema = z.enum(RECORD_WORKFLOW_TABLES)
export const recordWorkflowPageSchema = (table: RecordWorkflowTable) => z.object({
  items: z.array(rows[table]), nextCursor: z.string().nullable(), endCursor: z.string().nullable().optional(),
})

const context = { author: z.string().trim().min(1), reason: z.string().trim().min(1), sessionId: z.string().nullable().optional() }
export const recordWorkflowDraftSchema = z.object({
  kind: z.enum(['workflow', 'step_catalogue']), slug: z.string().min(1),
  event: z.enum(['set', 'fork', 'import']), definition: z.string().optional(),
  from: z.number().int().positive().nullable().optional(), ...context,
})
export const recordWorkflowTransitionSchema = z.object({
  kind: z.enum(['workflow', 'step_catalogue']), slug: z.string().min(1),
  n: z.number().int().positive(), expectedProductionVersion: z.number().int().positive().nullable(),
  ...context,
})
export type RecordWorkflowDraftInput = z.infer<typeof recordWorkflowDraftSchema>
export type RecordWorkflowTransitionInput = z.infer<typeof recordWorkflowTransitionSchema>
export const recordWorkflowWriteResponseSchema = z.object({
  identity, versions: z.array(version), events: z.array(event),
})
export type RecordWorkflowWriteResponse = z.infer<typeof recordWorkflowWriteResponseSchema>
