// concern: record-api-client
/** Validates the record change-feed transport at the HTTP client edge. */
import { z } from 'zod'
import type { RecordClientRequest } from './record-api-client-paths.ts'

const entryBase = {
  table: z.string(),
  id: z.string(),
  space: z.string(),
}
const entry = z.discriminatedUnion('op', [
  z.object({ ...entryBase, op: z.literal('upsert'), row: z.record(z.string(), z.unknown()) }),
  z.object({ ...entryBase, op: z.literal('delete') }),
])
const page = z.object({
  changes: z.array(entry),
  cursor: z.string(),
  lag: z.number().int().nonnegative(),
  more: z.boolean(),
})
const reset = z.object({ reset: z.literal(true), cursor: z.string(), tables: z.array(z.string()) })

export type RecordChangePage = z.infer<typeof page>
type RecordChangeListResult = RecordChangePage | { reset: { cursor: string; tables: string[] } }

const invalid = () => new Error('record API returned an invalid change page')
const parsePage = (body: unknown): RecordChangePage => {
  const parsed = page.safeParse(body)
  if (!parsed.success) throw invalid()
  return parsed.data
}
const parseReset = (body: unknown): RecordChangeListResult => {
  const parsed = reset.safeParse(body)
  if (!parsed.success) throw invalid()
  return { reset: { cursor: parsed.data.cursor, tables: parsed.data.tables } }
}

export type RecordChangesClient = {
  listChanges?(input: { after?: string; wait: number }): Promise<RecordChangeListResult>
}

export const recordChangesClient = (request: RecordClientRequest): RecordChangesClient => ({
  listChanges: ({ after, wait }) => {
    const search = new URLSearchParams({ wait: String(wait) })
    if (after) search.set('after', after)
    return request(`/v1/changes?${search}`, {
      schema: parsePage,
      acceptedError: { status: 410, schema: parseReset },
    })
  },
})
