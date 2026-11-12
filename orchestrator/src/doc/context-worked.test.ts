import { expect, test } from 'bun:test'
import { parseWorkedTaskKeys, renderWorkedTaskKeys, workedTaskKeys } from './context-worked.ts'

test('derives every worked source newest first and deduplicates by newest occurrence', () => {
  expect(
    workedTaskKeys({
      events: [
        { key: 'DEV-RUN', at: '2026-11-11T10:00:00Z' },
        { key: 'DEV-CURSOR', at: '2026-11-11T13:00:00Z' },
        { key: 'DEV-CLAIM', at: '2026-11-11T12:00:00Z' },
        { key: 'DEV-RUN', at: '2026-11-11T14:00:00Z' },
        { key: 'DEV-QUESTION', at: '2026-11-11T11:00:00Z' },
        { key: null, at: '2026-11-11T15:00:00Z' },
      ],
    }),
  ).toEqual(['DEV-RUN', 'DEV-CURSOR', 'DEV-CLAIM', 'DEV-QUESTION'])
})

test('worked fact keeps the newest keys that fit and reports the omitted count', () => {
  const keys = ['DEV-ONE', 'DEV-TWO', 'DEV-THREE-LONG-KEY-THAT-DOES-NOT-FIT']
  const body = renderWorkedTaskKeys(keys, 40)
  expect(body).toBe('Worked: DEV-ONE, DEV-TWO, and 1 more')
  expect(parseWorkedTaskKeys(body!)).toEqual(['DEV-ONE', 'DEV-TWO'])
  expect(renderWorkedTaskKeys([], 800)).toBeNull()
})
