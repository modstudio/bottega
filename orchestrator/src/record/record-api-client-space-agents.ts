// concern: record-api-client-space-agents
/** Builds hosted space-agent declaration methods. */
import type {
  RecordClientRequest,
  RecordRequestDestination,
  RecordWriteDestination,
} from './record-api-client-paths.ts'
import { RECORD_SPACE_AGENTS_ROUTE } from './record-api-client-paths.ts'
import type { RecordSpaceAgent } from './record-space-agents.ts'

export type RecordSpaceAgentClient = {
  listSpaceAgents(destination: RecordRequestDestination): Promise<RecordSpaceAgent[]>
  upsertSpaceAgent(
    input: RecordSpaceAgent,
    destination: RecordWriteDestination,
  ): Promise<RecordSpaceAgent>
  deleteSpaceAgent(
    name: string,
    destination: RecordWriteDestination,
  ): Promise<{ removed: boolean }>
}

export function recordSpaceAgentClient(request: RecordClientRequest): RecordSpaceAgentClient {
  return {
    listSpaceAgents: (destination) => request(RECORD_SPACE_AGENTS_ROUTE, destination),
    upsertSpaceAgent: (input, destination) =>
      request(RECORD_SPACE_AGENTS_ROUTE, {
        method: 'PUT',
        body: JSON.stringify(input),
        ...destination,
      }),
    deleteSpaceAgent: (name, destination) =>
      request(RECORD_SPACE_AGENTS_ROUTE, {
        method: 'DELETE',
        body: JSON.stringify({ name }),
        ...destination,
      }),
  }
}
