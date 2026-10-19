// concern: record-catalogue-contract
/** Shared transport result for atomic hosted catalogue imports. */
import { z } from 'zod'

export const recordCatalogueImportResultSchema = z.object({
  inserted: z.number().int().nonnegative(),
  alreadyPresent: z.number().int().nonnegative(),
  skipped: z.array(z.object({ id: z.string(), reason: z.string() })),
})
export type RecordCatalogueImportResult = z.infer<typeof recordCatalogueImportResultSchema>
