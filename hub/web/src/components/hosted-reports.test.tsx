import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { MeasuresResponse } from '@/trpc/client'
import { ProjectBreakdown } from './hosted-reports'

const measures: MeasuresResponse = {
  scope: 'project',
  hoursRunning: {
    notAdditive: true,
    unionMs: 3_600_000,
    sample: { intervalCount: 1 },
    from: { startedIntervals: 1, sessionIntervals: 0 },
  },
  agentHours: {
    from: 'started',
    sumMs: 3_600_000,
    sample: { intervalCount: 1 },
    unknownShare: { intervalCount: 1, sumMs: 3_600_000 },
  },
  sessionTime: {
    from: 'session',
    unionThenSumMs: 0,
    uncountedSilenceMs: 0,
    sample: { intervalCount: 0, userCount: 0 },
    silenceAllowanceMs: 600_000,
    silenceAllowanceSentence: 'Silences longer than ten minutes are not counted.',
    unknownUser: { unionThenSumMs: 0, uncountedSilenceMs: 0, sample: { intervalCount: 0 } },
  },
  cost: {
    from: 'started',
    vendorCostUsd: 3,
    vendorTokens: 3_400_000,
    sample: { intervalCount: 1 },
    unknownShare: { vendorCostUsd: 3, vendorTokens: 3_400_000, intervalCount: 1 },
  },
  shipped: { count: 1, sample: { taskCount: 1, eventCount: 1 } },
  cycleTime: { medianMs: 3_600_000, p90Ms: 3_600_000, n: 1 },
}

test('reports page uses the shared agent-token abbreviation', () => {
  const html = renderToStaticMarkup(
    <ProjectBreakdown projects={[{ name: 'workshop' }]} queries={[{ data: measures }]} />,
  )
  expect(html).toContain('3.4M agent tokens')
  expect(html).not.toContain('3,400,000')
})
