import { expect, test } from 'bun:test'
import { efficiencyWindows } from './efficiency-command.ts'

test('efficiency windows default to adjacent seven-day periods', () => {
  expect(efficiencyWindows(undefined, Date.parse('2026-10-15T00:00:00Z'))).toEqual({
    currentWindow: {
      start: '2026-10-08T00:00:00.000Z',
      end: '2026-10-15T00:00:00.000Z',
    },
    previousWindow: {
      start: '2026-10-01T00:00:00.000Z',
      end: '2026-10-08T00:00:00.000Z',
    },
  })
})
