import { expect, test } from 'bun:test'
import { recordRequestCount, recordRequestHeaders } from './record-request-headers.ts'

test('building request headers increments the process request count', () => {
  const before = recordRequestCount()

  recordRequestHeaders()

  expect(recordRequestCount()).toBe(before + 1)
})
