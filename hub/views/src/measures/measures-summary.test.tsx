import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { coreMeasures, MeasuresSummary, type MeasuresSummaryValue } from './measures-summary'

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

test('core measures keep one ordered set of summary and task labels', () => {
  expect(
    coreMeasures(shared).map(({ key, fullLabel, shortLabel, figure }) => ({
      key,
      fullLabel,
      shortLabel,
      figure,
    })),
  ).toEqual([
    {
      key: 'hours-running',
      fullLabel: 'How long any recorded work was in motion',
      shortLabel: 'in motion',
      figure: '1 hours',
    },
    {
      key: 'agent-hours',
      fullLabel: 'How much agent work was started',
      shortLabel: 'agent work',
      figure: '2 hours',
    },
    {
      key: 'session-time',
      fullLabel: 'How long people were in session',
      shortLabel: 'in session',
      figure: '1 hours',
    },
    {
      key: 'cost',
      fullLabel: 'What the started agent work cost',
      shortLabel: 'agent cost',
      figure: '$4.00',
    },
  ])
})

test('session honesty and unknown attribution render beside their numbers', () => {
  const measures: MeasuresSummaryValue = {
    ...shared,
    shipped: { count: 2 },
    cycleTime: { medianMs: 3_600_000, n: 2 },
  }
  const html = renderToStaticMarkup(<MeasuresSummary measures={measures} />)
  expect(html).toContain('Silences longer than ten minutes are not counted.')
  expect(html).toContain('0.3 hours uncounted silence')
  expect(html).toContain('attribution is mostly unknown')
  expect(html).toContain('Tasks done')
  expect(html).toContain('Tasks moved to done in this window.')
  expect(html).toContain('Cycle time for tasks done')
  expect(html).not.toMatch(/landed|shipped/i)
  expect(html).toContain('n=2')
})

test('absent cycle time and person-only outcome measures render nothing', () => {
  const person: MeasuresSummaryValue = {
    ...shared,
    agentHours: { ...shared.agentHours, unknownShare: undefined },
    sessionTime: { ...shared.sessionTime, unknownUser: undefined },
    cost: { ...shared.cost, unknownShare: undefined },
  }
  const html = renderToStaticMarkup(<MeasuresSummary measures={person} />)
  expect(html).not.toContain('Tasks done')
  expect(html).not.toContain('cycle time')
  expect(html).not.toContain('n=')
})
