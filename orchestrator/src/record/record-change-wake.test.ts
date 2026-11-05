import { expect, test } from 'bun:test'
import { createRecordChangeWakeSource } from './record-change-wake.ts'

test('a failed listener open falls back to polling and the next wait retries', async () => {
  let attempts = 0
  const listener = {
    async listen() {
      attempts += 1
      if (attempts === 1) throw new Error('listener unavailable')
      return { async unlisten() {} }
    },
    async close() {},
  }
  const source = createRecordChangeWakeSource('postgres://unused', listener)
  await source.wait(1)
  await source.wait(1)
  expect(attempts).toBe(2)
  await source.close()
})
