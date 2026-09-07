import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { HealthView } from './insight-view'

test('Health view renders rows and a last-seen sparkline from a stubbed client payload', () => {
  const html = renderToStaticMarkup(<HealthView data={{
    header: 'Harness health only — never routing evidence.',
    days: 14,
    from: '2026-08-24T00:00:00.000Z',
    classes: [{
      kind: 'interrupted', count: 2, totalTimeMs: 1_020_000, meanTimeMs: 510_000,
      firstSeen: '2026-09-06T10:00:00.000Z', lastSeen: '2026-09-07T10:00:00.000Z',
      clusters: [], sparkline: [
        { day: '2026-09-06', count: 1 }, { day: '2026-09-07', count: 1 },
      ],
    }],
    falseVerdicts: [{ kind: 'escaped', verdicts: 2, falseVerdicts: 1, rate: 0.5 }],
    landingRefusals: 3,
  }} />)
  expect(html).toContain('interrupted')
  expect(html).toContain('2026-09-06: 1')
  expect(html).toContain('escaped')
  expect(html).toContain('50.0%')
  expect(html).toContain('3 landing refusals')
})
