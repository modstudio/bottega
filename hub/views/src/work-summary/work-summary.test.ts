import { expect, test } from 'bun:test'
import { responseSubtitle } from './work-summary.ts'

test('the header names a failing collector leg and truncates its error', () => {
  const subtitle = responseSubtitle({
    collectedAt: '2026-11-20T11:00:00.000Z',
    servingSince: '2026-11-20T10:00:00.000Z',
    activeAgents: [],
    collectorLegs: [
      {
        source: 'runs',
        lastSuccessAt: '2026-11-20T11:00:00.000Z',
        lastError: 'x'.repeat(200),
        lastErrorAt: '2026-11-20T11:01:00.000Z',
        failingSince: '2026-11-20T11:01:00.000Z',
        status: 'failing',
        ageMs: 1,
      },
    ],
  })

  expect(subtitle.text).toStartWith('Collector runs failing since ')
  expect(subtitle.text.length).toBeLessThan(180)
  expect(subtitle.text).toEndWith('…')
})
