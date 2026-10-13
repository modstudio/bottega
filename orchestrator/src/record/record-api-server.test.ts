import { expect, test } from 'bun:test'
import { stopRecordApiServer } from './record-api-server.ts'
import {
  boardStreamResponse,
  createBoardStreamRegistry,
  type BoardWakeSource,
} from './record-board-stream.ts'

test('stopping the server ends an open board stream before closing its wake source', async () => {
  const registry = createBoardStreamRegistry()
  const listeners = new Set<() => void>()
  let wakeSourceClosed = false
  const wakeSource: BoardWakeSource & { close(): Promise<void> } = {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async close() {
      expect(listeners.size).toBe(0)
      wakeSourceClosed = true
    },
  }
  const response = boardStreamResponse({
    readTenant: async () => ({
      url: 'postgres://record.test/record',
      userId: 'user-a',
      spaceId: 'space-a',
      spaceIds: ['space-a'],
    }),
    readHead: async () => '0',
    wakeSource,
    registry,
    signal: new AbortController().signal,
  })
  const reader = response.body!.getReader()
  expect((await reader.read()).done).toBe(false)
  let serverStopped = false
  await stopRecordApiServer({
    stop() {
      expect(wakeSourceClosed).toBe(true)
      serverStopped = true
    },
    boardWakeSource: wakeSource,
    boardStreamRegistry: registry,
  })
  expect((await reader.read()).done).toBe(true)
  expect(wakeSourceClosed).toBe(true)
  expect(serverStopped).toBe(true)
})
