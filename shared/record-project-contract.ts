import { z } from 'zod'

/** The additive wire contract returned by GET /v1/projects. */
export const RecordProjectSchema = z.object({
  id: z.string(),
  spaceId: z.string(),
  spaceName: z.string(),
  name: z.string(),
  keyPrefixes: z.array(z.string()),
  stack: z.string().nullable(),
  managedContext: z.boolean(),
  landingBranch: z.string().nullable(),
  color: z.string().nullable(),
  colorDark: z.string().nullable(),
  retiredAt: z.string().nullable(),
  canon: z.boolean().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
})

export const RecordProjectsSchema = z.array(RecordProjectSchema)

export type RecordProject = z.infer<typeof RecordProjectSchema>
