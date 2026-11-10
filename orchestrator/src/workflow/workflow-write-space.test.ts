import { expect, test } from 'bun:test'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { workflowWriteSpace } from './workflow-write-space.ts'

test('a local-only workflow write needs no space and makes no hosted call', async () => {
  let whoamiCalls = 0
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    async whoami() {
      whoamiCalls += 1
      throw new Error('local workflow destination reached the hosted record')
    },
  })
  try {
    expect(await workflowWriteSpace('workflow set', ['workflow', 'set'], false)).toBe('')
    expect(whoamiCalls).toBe(0)
  } finally {
    installRecordApiClient(null)
  }
})
