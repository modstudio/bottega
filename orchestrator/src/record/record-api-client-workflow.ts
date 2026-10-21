// concern: record-api-client
/** Implements decoded workflow catalogue requests outside the main client file ceiling. */
import { type RecordRequestDestination, workflowCataloguePath } from './record-api-client-paths.ts'
import {
  type RecordWorkflowDraftInput,
  type RecordWorkflowImportInput,
  type RecordWorkflowImportResult,
  type RecordWorkflowTable,
  type RecordWorkflowTransitionInput,
  type RecordWorkflowWriteResponse,
  recordWorkflowImportResultSchema,
  recordWorkflowPageSchema,
  recordWorkflowWriteResponseSchema,
} from './record-workflow-contract.ts'

type Request = <T>(
  path: string,
  init?: RequestInit & { schema?: (body: unknown) => T; destinationSpaceId?: string },
) => Promise<T>
const RECONCILED_IMPORT_REFUSAL =
  'record API predates reconciled workflow import; release hosted-api, then retry'

async function importWorkflowCatalogue(
  request: Request,
  input: RecordWorkflowImportInput,
  destination?: RecordRequestDestination,
): Promise<RecordWorkflowImportResult> {
  try {
    return await request('/v1/workflow-catalogue/import/v2', {
      method: 'POST',
      body: JSON.stringify(input),
      ...destination,
      schema: (body) => recordWorkflowImportResultSchema.parse(body),
    })
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'status' in error &&
      (error.status === 404 || error.status === 405)
    )
      throw new Error(RECONCILED_IMPORT_REFUSAL)
    throw error
  }
}
export type RecordWorkflowClient = {
  listWorkflowCatalogue?(
    table: RecordWorkflowTable,
    query: { limit?: number; cursor?: string },
    destination?: RecordRequestDestination,
  ): Promise<{
    items: Record<string, unknown>[]
    nextCursor: string | null
    endCursor?: string | null
  }>
  draftWorkflow?(
    input: RecordWorkflowDraftInput,
    destination?: RecordRequestDestination,
  ): Promise<RecordWorkflowWriteResponse>
  promoteWorkflow?(
    input: RecordWorkflowTransitionInput,
    destination?: RecordRequestDestination,
  ): Promise<RecordWorkflowWriteResponse>
  retireWorkflow?(
    input: RecordWorkflowTransitionInput,
    destination?: RecordRequestDestination,
  ): Promise<RecordWorkflowWriteResponse>
  importWorkflowCatalogue?(
    input: RecordWorkflowImportInput,
    destination?: RecordRequestDestination,
  ): Promise<RecordWorkflowImportResult>
}
export const recordWorkflowClient = (request: Request): RecordWorkflowClient => ({
  listWorkflowCatalogue: (table, query, destination) =>
    request(workflowCataloguePath(table, query), {
      ...destination,
      schema: (body) => recordWorkflowPageSchema(table).parse(body),
    }),
  draftWorkflow: (input, destination) =>
    request('/v1/workflow-catalogue/draft', {
      method: 'POST',
      body: JSON.stringify(input),
      ...destination,
      schema: (body) => recordWorkflowWriteResponseSchema.parse(body),
    }),
  promoteWorkflow: (input, destination) =>
    request('/v1/workflow-catalogue/promote', {
      method: 'POST',
      body: JSON.stringify(input),
      ...destination,
      schema: (body) => recordWorkflowWriteResponseSchema.parse(body),
    }),
  retireWorkflow: (input, destination) =>
    request('/v1/workflow-catalogue/retire', {
      method: 'POST',
      body: JSON.stringify(input),
      ...destination,
      schema: (body) => recordWorkflowWriteResponseSchema.parse(body),
    }),
  importWorkflowCatalogue: (input, destination) =>
    importWorkflowCatalogue(request, input, destination),
})
