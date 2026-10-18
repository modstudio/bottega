// concern: record-api-client
/** Implements decoded workflow catalogue requests outside the main client file ceiling. */
import { workflowCataloguePath, type RecordRequestDestination } from './record-api-client-paths.ts'
import {
  type RecordWorkflowDraftInput, type RecordWorkflowTable, type RecordWorkflowTransitionInput,
  type RecordWorkflowWriteResponse, recordWorkflowPageSchema, recordWorkflowWriteResponseSchema,
} from './record-workflow-contract.ts'
type Request = <T>(path: string, init?: RequestInit & { schema?: (body: unknown) => T; destinationSpaceId?: string }) => Promise<T>
export type RecordWorkflowClient = {
  listWorkflowCatalogue?(table: RecordWorkflowTable, query: { limit?: number; cursor?: string }, destination?: RecordRequestDestination): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null; endCursor?: string | null }>
  draftWorkflow?(input: RecordWorkflowDraftInput, destination?: RecordRequestDestination): Promise<RecordWorkflowWriteResponse>
  promoteWorkflow?(input: RecordWorkflowTransitionInput, destination?: RecordRequestDestination): Promise<RecordWorkflowWriteResponse>
  retireWorkflow?(input: RecordWorkflowTransitionInput, destination?: RecordRequestDestination): Promise<RecordWorkflowWriteResponse>
}
export const recordWorkflowClient = (request: Request): RecordWorkflowClient => ({
  listWorkflowCatalogue: (table, query, destination) => request(workflowCataloguePath(table, query), { ...destination, schema: (body) => recordWorkflowPageSchema(table).parse(body) }),
  draftWorkflow: (input, destination) => request('/v1/workflow-catalogue/draft', { method: 'POST', body: JSON.stringify(input), ...destination, schema: (body) => recordWorkflowWriteResponseSchema.parse(body) }),
  promoteWorkflow: (input, destination) => request('/v1/workflow-catalogue/promote', { method: 'POST', body: JSON.stringify(input), ...destination, schema: (body) => recordWorkflowWriteResponseSchema.parse(body) }),
  retireWorkflow: (input, destination) => request('/v1/workflow-catalogue/retire', { method: 'POST', body: JSON.stringify(input), ...destination, schema: (body) => recordWorkflowWriteResponseSchema.parse(body) }),
})
