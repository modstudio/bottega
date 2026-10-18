// concern: record-api-client
/** Implements decoded lens catalogue requests outside the main client file ceiling. */

import { lensCataloguePath, type RecordRequestDestination } from './record-api-client-paths.ts'
import { type RecordWorkflowClient, recordWorkflowClient } from './record-api-client-workflow.ts'
import {
  type RecordLensProfileWriteInput,
  type RecordLensProfileWriteResponse,
  type RecordLensTable,
  type RecordLensWriteInput,
  type RecordLensWriteResponse,
  type RecordProjectLensSelectionInput,
  type RecordProjectLensSelectionResponse,
  recordLensPageSchema,
  recordLensProfileWriteResponseSchema,
  recordLensWriteResponseSchema,
  recordProjectLensSelectionResponseSchema,
} from './record-lens-contract.ts'
export type RecordCatalogueClient = RecordLensClient & RecordWorkflowClient

type Request = <T>(
  path: string,
  init?: RequestInit & { schema?: (body: unknown) => T; destinationSpaceId?: string },
) => Promise<T>
type RecordLensClient = {
  listLensCatalogue(
    table: RecordLensTable,
    query: { limit?: number; cursor?: string },
    destination?: RecordRequestDestination,
  ): Promise<{
    items: Record<string, unknown>[]
    nextCursor: string | null
    endCursor?: string | null
  }>
  upsertLens(
    input: RecordLensWriteInput,
    destination?: RecordRequestDestination,
  ): Promise<RecordLensWriteResponse>
  upsertLensProfile(
    input: RecordLensProfileWriteInput,
    destination?: RecordRequestDestination,
  ): Promise<RecordLensProfileWriteResponse>
  selectProjectLensProfile(
    input: RecordProjectLensSelectionInput,
    destination?: RecordRequestDestination,
  ): Promise<RecordProjectLensSelectionResponse>
}

export const recordLensClient = (request: Request): RecordCatalogueClient => ({
  listLensCatalogue: (table, query, destination) =>
    request(lensCataloguePath(table, query), {
      ...destination,
      schema: (body) => recordLensPageSchema(table).parse(body),
    }),
  upsertLens: (input, destination) =>
    request('/v1/lens-catalogue/lenses', {
      method: 'PUT',
      body: JSON.stringify(input),
      ...destination,
      schema: (body) => recordLensWriteResponseSchema.parse(body),
    }),
  upsertLensProfile: (input, destination) =>
    request('/v1/lens-catalogue/profiles', {
      method: 'PUT',
      body: JSON.stringify(input),
      ...destination,
      schema: (body) => recordLensProfileWriteResponseSchema.parse(body),
    }),
  selectProjectLensProfile: (input, destination) =>
    request('/v1/lens-catalogue/selections', {
      method: 'PUT',
      body: JSON.stringify(input),
      ...destination,
      schema: (body) => recordProjectLensSelectionResponseSchema.parse(body),
    }),
  ...recordWorkflowClient(request),
})
