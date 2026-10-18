// concern: record-port-contract
/** Pure transport contract for hosted port items. */
import { z } from 'zod'

export const RECORD_PORT_TABLES = [
  'port_doctrine',
  'port_pair',
  'port_baseline',
  'port_ref',
  'port_ref_source',
  'port_skip',
] as const
export type RecordPortTable = (typeof RECORD_PORT_TABLES)[number]

export class RecordPortError extends Error {
  readonly status: number
  constructor(message: string, status = 409) {
    super(message)
    this.status = status
  }
}

const uuid = z.string().uuid()
const iso = z.string().datetime({ offset: true })
const common = { id: uuid, spaceId: uuid }
const recordPortRows = {
  port_doctrine: z.object({
    ...common,
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string(),
    createdAt: iso,
    retiredAt: iso.nullable(),
    version: z.number().int().positive(),
    updatedAt: iso,
  }),
  port_pair: z.object({
    ...common,
    sourceProjectId: uuid,
    targetProjectId: uuid,
    createdAt: iso,
  }),
  port_baseline: z.object({
    ...common,
    pairId: uuid,
    sourceCommit: z.string().nullable(),
    scannedAt: iso.nullable(),
    version: z.number().int().positive(),
    updatedAt: iso,
  }),
  port_ref: z.object({
    ...common,
    taskKey: z.string().min(1),
    targetProjectId: uuid,
    note: z.string(),
    createdAt: iso,
    resolvedAt: iso.nullable(),
    deletedAt: iso.nullable(),
    version: z.number().int().positive(),
    updatedAt: iso,
  }),
  port_ref_source: z.object({
    ...common,
    refId: uuid,
    sourceProjectId: uuid,
    commits: z.string(),
    paths: z.string(),
    note: z.string(),
    deletedAt: iso.nullable(),
    updatedAt: iso,
  }),
  port_skip: z.object({
    ...common,
    pairId: uuid,
    candidate: z.string(),
    reason: z.string(),
    skippedAt: iso,
  }),
} as const
export const recordPortTableSchema = z.enum(RECORD_PORT_TABLES)
export const recordPortPageSchema = (table: RecordPortTable) =>
  z.object({
    items: z.array(recordPortRows[table]),
    nextCursor: z.string().nullable(),
    endCursor: z.string().nullable().optional(),
  })

const source = z.object({
  sourceProjectId: uuid,
  commits: z.array(z.string()),
  paths: z.array(z.string()),
  note: z.string(),
})
export const recordPortWriteSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('add_doctrine'),
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string(),
    createdAt: iso,
  }),
  z.object({
    action: z.literal('retire_doctrine'),
    number: z.number().int().positive(),
    expectedVersion: z.number().int().positive(),
    retiredAt: iso,
  }),
  z.object({
    action: z.literal('set_baseline'),
    sourceProjectId: uuid,
    targetProjectId: uuid,
    sourceCommit: z.string().nullable(),
    scannedAt: iso.nullable(),
    expectedVersion: z.number().int().positive().nullable(),
  }),
  z.object({
    action: z.literal('add_skip'),
    sourceProjectId: uuid,
    targetProjectId: uuid,
    candidate: z.string(),
    reason: z.string(),
    skippedAt: iso,
  }),
  z.object({
    action: z.literal('set_ref'),
    taskKey: z.string().min(1),
    targetProjectId: uuid,
    note: z.string(),
    sources: z.array(source).min(1),
    createdAt: iso,
    expectedVersion: z.number().int().positive().nullable(),
  }),
  z.object({
    action: z.enum(['resolve_ref', 'delete_ref']),
    taskKey: z.string().min(1),
    targetProjectId: uuid,
    expectedVersion: z.number().int().positive(),
    at: iso,
  }),
])
export type RecordPortWriteInput = z.infer<typeof recordPortWriteSchema>
export const recordPortWriteResponseSchema = z.object({
  doctrine: recordPortRows.port_doctrine.optional(),
  pair: recordPortRows.port_pair.optional(),
  baseline: recordPortRows.port_baseline.optional(),
  ref: recordPortRows.port_ref.optional(),
  sources: z.array(recordPortRows.port_ref_source).optional(),
  skip: recordPortRows.port_skip.optional(),
})
export type RecordPortWriteResponse = z.infer<typeof recordPortWriteResponseSchema>
