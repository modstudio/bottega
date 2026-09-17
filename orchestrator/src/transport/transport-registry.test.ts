import { expect, test } from 'bun:test'
import { registerStandardTransports } from '../runtime/standard-transports.ts'
import {
  clearRegisteredTransportsForTest,
  TransportOperationTimeout,
  transportFor,
  withTransportDeadline,
} from './transport.ts'

test('transport selection refuses when entrypoint registration is missing', () => {
  clearRegisteredTransportsForTest()
  try {
    expect(() => transportFor('cli')).toThrow(/registerStandardTransports\(\)/)
  } finally {
    registerStandardTransports()
  }
})

test('a transport operation deadline cancels and names the operation', async () => {
  let cancelled = false
  await expect(
    withTransportDeadline({
      operation: new Promise<never>(() => {}),
      operationName: 'goose agent probe collection',
      timeoutMs: 20 * 60_000,
      onTimeout: () => {
        cancelled = true
      },
      schedule: (callback, delay) => {
        expect(delay).toBe(20 * 60_000)
        queueMicrotask(callback)
        return 1 as unknown as ReturnType<typeof setTimeout>
      },
      unschedule: () => {},
    }),
  ).rejects.toEqual(new TransportOperationTimeout('goose agent probe collection', 20 * 60_000))
  expect(cancelled).toBe(true)
})
