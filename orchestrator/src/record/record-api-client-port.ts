// concern: record-api-client
/** Implements decoded port catalogue requests outside the main client file ceiling. */
import type { RecordRequestDestination } from './record-api-client-paths.ts'
import {
  type RecordCatalogueImportResult,
  recordCatalogueImportResultSchema,
} from './record-catalogue-contract.ts'
import {
  type RecordPortImportInput,
  type RecordPortRow,
  type RecordPortTable,
  type RecordPortWriteInput,
  type RecordPortWriteResponse,
  recordPortPageSchema,
  recordPortWriteResponseSchema,
} from './record-port-contract.ts'

type Request = <T>(
  path: string,
  init?: RequestInit & { schema?: (body: unknown) => T; destinationSpaceId?: string },
) => Promise<T>
const path = (table: string, query: { limit?: number; cursor?: string }) => {
  const search = new URLSearchParams()
  if (query.limit) search.set('limit', String(query.limit))
  if (query.cursor) search.set('cursor', query.cursor)
  const suffix = search.toString()
  return `/v1/port-catalogue/${encodeURIComponent(table)}${suffix ? `?${suffix}` : ''}`
}
export type RecordPortClient = {
  listPortCatalogue?(
    table: RecordPortTable,
    query: { limit?: number; cursor?: string },
    destination?: RecordRequestDestination,
  ): Promise<{
    items: RecordPortRow[]
    nextCursor: string | null
    endCursor?: string | null
  }>
  writePort?(
    input: RecordPortWriteInput,
    destination?: RecordRequestDestination,
  ): Promise<RecordPortWriteResponse>
  importPortCatalogue?(
    input: RecordPortImportInput,
    destination?: RecordRequestDestination,
  ): Promise<RecordCatalogueImportResult>
}
export const recordPortClient = (request: Request): RecordPortClient => ({
  listPortCatalogue: (table, query, destination) =>
    request(path(table, query), {
      ...destination,
      schema: (body) => recordPortPageSchema(table).parse(body),
    }),
  writePort: (input, destination) =>
    request('/v1/port-catalogue/write', {
      method: 'POST',
      body: JSON.stringify(input),
      ...destination,
      schema: (body) => recordPortWriteResponseSchema.parse(body),
    }),
  importPortCatalogue: (input, destination) =>
    request('/v1/port-catalogue/import', {
      method: 'POST',
      body: JSON.stringify(input),
      ...destination,
      schema: (body) => recordCatalogueImportResultSchema.parse(body),
    }),
})
