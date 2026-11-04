// concern: hosted task-flow client
import type { RecordRequestDestination } from './record-api-client-paths.ts'
import { type HostedTaskFlow, hostedTaskFlowSchema } from './record-task-flow-contract.ts'

type Request = <T>(
  path: string,
  init?: RequestInit & { schema?: (body: unknown) => T; destinationSpaceId?: string },
) => Promise<T>
export type RecordTaskFlowClient = {
  readTaskFlow?(
    selector: { taskKey?: string; flowRecordId?: string },
    destination?: RecordRequestDestination,
  ): Promise<HostedTaskFlow>
}
export const recordTaskFlowClient = (request: Request): RecordTaskFlowClient => ({
  readTaskFlow: (selector, destination) => {
    const query = new URLSearchParams()
    if (selector.taskKey) query.set('taskKey', selector.taskKey)
    if (selector.flowRecordId) query.set('flowRecordId', selector.flowRecordId)
    return request(`/v1/task-flow?${query}`, {
      ...destination,
      schema: (body) => hostedTaskFlowSchema.parse(body),
    })
  },
})
