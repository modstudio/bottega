import { expect, test } from 'bun:test'
import { briefsAtBoundaries } from './session-losses-adapter.ts'

test('brief measurements attach to their compaction boundary and stay blank when absent', () => {
  expect(
    briefsAtBoundaries(
      ['2026-11-13T12:00:00.000Z', '2026-11-13T13:00:00.000Z'],
      [
        {
          at: '2026-11-13T12:00:01.000Z',
          bytes: 10_120,
          lines: 80,
          over_cap: 1,
        },
      ],
    ),
  ).toEqual([{ bytes: 10_120, lines: 80, overCap: true }, null])
})
