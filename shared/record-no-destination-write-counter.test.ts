import { expect, test } from 'bun:test'
import { parseNoDestinationWriteReport } from './record-no-destination-write-contract.ts'
import { createNoDestinationWriteCounter } from './record-no-destination-write-counter.ts'

const emptyReport = async () => ({
  windowStart: '2026-10-28T00:00:00.000Z',
  counts: [],
})

test('a failed insert is counted only for reports that include its space', async () => {
  const counter = createNoDestinationWriteCounter()
  await expect(
    counter.record({ spaceId: 'space-a', route: '/a', cause: 'cli/1' }, async () => {
      throw new Error('database unavailable')
    }),
  ).resolves.toBeUndefined()
  expect((await counter.read(['space-a'], emptyReport)).unrecorded).toBe(1)
  expect((await counter.read(['space-b'], emptyReport)).unrecorded).toBe(0)
})

test('a failed report load rejects instead of reporting zero', async () => {
  const counter = createNoDestinationWriteCounter()
  await expect(
    counter.read(['space-a'], async () => {
      throw new Error('database unavailable')
    }),
  ).rejects.toThrow('database unavailable')
})

test('the report parser refuses the process-local shape with a deployment remedy', () => {
  expect(() =>
    parseNoDestinationWriteReport(
      { processStartedAt: '2026-11-11T00:00:00.000Z', counts: [] },
      'hosted API',
    ),
  ).toThrow('deploy the current hosted API and hub, then retry')
})
