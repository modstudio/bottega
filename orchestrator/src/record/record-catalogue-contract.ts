// concern: record-catalogue-contract
/** Shared transport result for atomic hosted catalogue imports. */
import { z } from 'zod'

export const recordCatalogueImportResultSchema = z.object({
  inserted: z.number().int().nonnegative(),
  alreadyPresent: z.number().int().nonnegative(),
  skipped: z.array(z.object({ id: z.string(), reason: z.string() })),
  outcomes: z.array(
    z.object({
      kind: z.enum(['workflow', 'step_catalogue']),
      slug: z.string(),
      outcome: z.enum(['replaced seeded built-in', 'local production imported as draft']),
    }),
  ),
})
export type RecordCatalogueImportResult = z.infer<typeof recordCatalogueImportResultSchema>
