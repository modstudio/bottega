// concern: record-api-lens-schemas
/** Validates lens catalogue requests and responses at transport edges. */
import { z } from 'zod'
import { RECORD_LENS_TABLES } from './record-lens-catalogue.ts'

const uuid = z.string().uuid()
const iso = z.string().datetime({ offset: true })
const axis = z.enum(['framework', 'architecture'])
const common = { id: uuid, spaceId: uuid }
export const recordLensTableSchema = z.enum(RECORD_LENS_TABLES)
export const recordLensRowSchemas = {
  lens: z.object({
    ...common,
    key: z.string().min(1),
    title: z.string(),
    question: z.string(),
    excludes: z.string(),
    slots: z.string(),
    version: z.number().int().positive(),
    enabled: z.boolean(),
    requiresExecution: z.boolean(),
    updatedAt: iso,
  }),
  lens_revision: z.object({
    ...common,
    lensId: uuid,
    version: z.number().int().positive(),
    priorBody: z.string(),
    reason: z.string().min(1),
    sessionId: z.string().nullable(),
    at: iso,
  }),
  lens_profile: z.object({
    ...common,
    lensId: uuid,
    axis,
    name: z.string().min(1),
    version: z.number().int().positive(),
    body: z.string(),
    enabled: z.boolean(),
    updatedAt: iso,
  }),
  lens_profile_revision: z.object({
    ...common,
    profileId: uuid,
    version: z.number().int().positive(),
    priorBody: z.string(),
    reason: z.string().min(1),
    sessionId: z.string().nullable(),
    at: iso,
  }),
  project_lens_profile: z.object({
    ...common,
    projectId: uuid,
    lensId: uuid.nullable(),
    axis,
    profileName: z.string().min(1),
    selectedVersion: z.number().int().positive().nullable(),
    selectionVersion: z.number().int().positive(),
    updatedAt: iso,
  }),
  project_lens_profile_revision: z.object({
    ...common,
    selectionId: uuid,
    priorProfileName: z.string().nullable(),
    priorSelectedVersion: z.number().int().positive().nullable(),
    reason: z.string().min(1),
    sessionId: z.string().nullable(),
    at: iso,
  }),
} as const
const pageFields = {
  nextCursor: z.string().nullable(),
  endCursor: z.string().nullable().optional(),
}
export const recordLensPageSchema = (table: keyof typeof recordLensRowSchemas) =>
  z.object({ items: z.array(recordLensRowSchemas[table]), ...pageFields })

const context = { reason: z.string().trim().min(1), sessionId: z.string().nullable().optional() }
export const recordLensUpsertSchema = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  question: z.string().min(1),
  excludes: z.string().min(1),
  slots: z.string(),
  enabled: z.boolean(),
  requiresExecution: z.boolean(),
  expectedVersion: z.number().int().positive().nullable(),
  ...context,
})
export const recordLensProfileUpsertSchema = z.object({
  lensKey: z.string().min(1),
  axis,
  name: z.string().min(1),
  body: z.string(),
  enabled: z.boolean(),
  expectedVersion: z.number().int().positive().nullable(),
  ...context,
})
export const recordProjectLensSelectionSchema = z.object({
  projectId: uuid,
  lensKey: z.string().min(1).nullable().optional(),
  axis,
  profileName: z.string().min(1),
  selectedVersion: z.number().int().positive().nullable(),
  expectedSelectionVersion: z.number().int().positive().nullable(),
  ...context,
})

export const recordLensWriteResponseSchema = z.object({
  lens: recordLensRowSchemas.lens,
  revision: recordLensRowSchemas.lens_revision.nullable(),
})
export const recordLensProfileWriteResponseSchema = z.object({
  profile: recordLensRowSchemas.lens_profile,
  revision: recordLensRowSchemas.lens_profile_revision.nullable(),
})
export const recordProjectLensSelectionResponseSchema = z.object({
  selection: recordLensRowSchemas.project_lens_profile,
  revision: recordLensRowSchemas.project_lens_profile_revision,
})
export type RecordLensWriteResponse = z.infer<typeof recordLensWriteResponseSchema>
export type RecordLensProfileWriteResponse = z.infer<typeof recordLensProfileWriteResponseSchema>
export type RecordProjectLensSelectionResponse = z.infer<
  typeof recordProjectLensSelectionResponseSchema
>
