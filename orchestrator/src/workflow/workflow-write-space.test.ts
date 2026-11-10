import { expect, test } from 'bun:test'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { workflowWriteSpace } from './workflow-write-space.ts'

test('a local-only workflow write needs no space and makes no hosted call', async () => {
  const previousRecordApiUrl = process.env.BOTTEGA_RECORD_API_URL
  let whoamiCalls = 0
  delete process.env.BOTTEGA_RECORD_API_URL
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    async whoami() {
      whoamiCalls += 1
      throw new Error('local workflow destination reached the hosted record')
    },
  })

  try {
    expect(await workflowWriteSpace('workflow set', ['workflow', 'set'])).toBe('')
    expect(whoamiCalls).toBe(0)
  } finally {
    if (previousRecordApiUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
    else process.env.BOTTEGA_RECORD_API_URL = previousRecordApiUrl
    installRecordApiClient(null)
  }
})
