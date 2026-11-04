// concern: record-api-client-outside-block
/** Owns hosted outside-author block requests. */

import type { RecordClientRequest } from './record-api-client-paths.ts'
import type { OutsideBlock } from './record-outside-block.ts'

export type RecordOutsideBlockClient = {
  listOutsideBlocks(): Promise<{ blocks: OutsideBlock[] }>
  blockOutsideAuthor(input: {
    message?: string
    note?: string
    hours?: number
  }): Promise<{ block: OutsideBlock }>
  unblockOutsideAuthor(userId: string): Promise<{ unblocked: string }>
}

export function recordOutsideBlockClient(request: RecordClientRequest): RecordOutsideBlockClient {
  return {
    listOutsideBlocks: () => request('/v1/outside-blocks'),
    blockOutsideAuthor: (input) =>
      request('/v1/outside-blocks', { method: 'POST', body: JSON.stringify(input) }),
    unblockOutsideAuthor: (userId) =>
      request(`/v1/outside-blocks/${encodeURIComponent(userId)}`, { method: 'DELETE' }),
  }
}
