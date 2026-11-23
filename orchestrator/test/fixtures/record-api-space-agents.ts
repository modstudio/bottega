import type { RecordSpaceAgentClient } from '../../src/record/record-api-client-space-agents.ts'

const unused = async (): Promise<never> =>
  Promise.reject(new Error('hosted space agents are unused in this fixture'))

export const idleSpaceAgentDeps = () => ({
  readSpaceAgents: unused,
  upsertSpaceAgent: unused,
  deleteSpaceAgent: unused,
})

export const memorySpaceAgentClient = (): RecordSpaceAgentClient => ({
  listSpaceAgents: async () => [],
  upsertSpaceAgent: async (input) => input,
  deleteSpaceAgent: async () => ({ removed: false }),
})
