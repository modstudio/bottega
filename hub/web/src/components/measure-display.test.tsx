import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { MeasuresResponse } from '@/trpc/client'
import { ProjectBreakdown } from './hosted-reports'
import { MeasuresSummary } from './measure-display'

const shared = {
  hoursRunning: {
    notAdditive: true as const,
    unionMs: 3_600_000,
    sample: { intervalCount: 4 },
    from: { startedIntervals: 2, sessionIntervals: 2 },
  },
  agentHours: {
    from: 'started' as const,
    sumMs: 7_200_000,
    sample: { intervalCount: 2 },
    unknownShare: { intervalCount: 1, sumMs: 5_400_000 },
  },
  sessionTime: {
    from: 'session' as const,
    unionThenSumMs: 3_600_000,
    uncountedSilenceMs: 900_000,
    sample: { intervalCount: 2, userCount: 1 },
    silenceAllowanceMs: 600_000,
    silenceAllowanceSentence: 'Silences longer than ten minutes are not counted.',
    unknownUser: {
      unionThenSumMs: 7_200_000,
      uncountedSilenceMs: 1_800_000,
      sample: { intervalCount: 1 },
    },
  },
  cost: {
    from: 'started' as const,
    vendorCostUsd: 4,
    vendorTokens: 100,
    sample: { intervalCount: 2 },
    unknownShare: { vendorCostUsd: 3, vendorTokens: 75, intervalCount: 1 },
  },
}

test('session honesty and unknown attribution render beside their numbers', () => {
  const measures: MeasuresResponse = {
    scope: 'space',
    ...shared,
    shipped: { count: 2, sample: { taskCount: 2, eventCount: 2 } },
    cycleTime: { medianMs: 3_600_000, p90Ms: 7_200_000, n: 2 },
  }
  const html = renderToStaticMarkup(<MeasuresSummary measures={measures} />)
  expect(html).toContain('Silences longer than ten minutes are not counted.')
  expect(html).toContain('0.3 hours uncounted silence')
  expect(html).toContain('attribution is mostly unknown')
  expect(html).toContain('n=2')
})

test('absent cycle time and person-only outcome measures render nothing', () => {
  const person: MeasuresResponse = {
    scope: 'person',
    ...shared,
    agentHours: { ...shared.agentHours, unknownShare: undefined },
    sessionTime: { ...shared.sessionTime, unknownUser: undefined },
    cost: { ...shared.cost, unknownShare: undefined },
  }
  const html = renderToStaticMarkup(<MeasuresSummary measures={person} />)
  expect(html).not.toContain('How many tasks landed')
  expect(html).not.toContain('cycle time')
  expect(html).not.toContain('n=')
})

test('project hours-running breakdown offers no total row', () => {
  const measures: MeasuresResponse = {
    scope: 'project',
    ...shared,
    shipped: { count: 0, sample: { taskCount: 0, eventCount: 0 } },
  }
  const html = renderToStaticMarkup(
    <ProjectBreakdown projects={[{ name: 'alpha' }]} queries={[{ data: measures }]} />,
  )
  expect(html).toContain('Hours running')
  expect(html).not.toContain('Total')
})
