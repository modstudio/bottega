import { expect, test } from 'bun:test'
import { parseNoDestinationWriteReport } from './record-no-destination-write-contract.ts'
import { createNoDestinationWriteCounter } from './record-no-destination-write-counter.ts'

const emptyReport = async () => ({
  windowStart: '2026-10-28T00:00:00.000Z',
  counts: [],
})

test('reports durable rows supplied by the application store', async () => {
  const counter = createNoDestinationWriteCounter()
  const counts = [
    {
      spaceId: 'space-a',
      route: '/a',
      cause: 'cli/1',
      occurrences: 2,
      lastAt: '2026-11-11T00:00:00.000Z',
    },
  ]
  expect(
    await counter.read(['space-a'], async () => ({
      windowStart: '2026-10-28T00:00:00.000Z',
      counts,
    })),
  ).toEqual({ windowStart: '2026-10-28T00:00:00.000Z', unrecorded: 0, counts })
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

test('the report parser refuses the process-local shape with a deployment remedy', () => {
  expect(() =>
    parseNoDestinationWriteReport(
      { processStartedAt: '2026-11-11T00:00:00.000Z', counts: [] },
      'hosted API',
    ),
  ).toThrow('deploy the current hosted API and hub, then retry')
})
