import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  CLEAR_HOSTED_PRESSURE_STATE,
  decideHostedPressure,
  HOSTED_API_P95_THRESHOLD_SECONDS,
  HOSTED_PRESSURE_CLEAR_MS,
  HOSTED_STEAL_THRESHOLD,
  HOSTED_THROTTLE_THRESHOLD,
  type HostedPressureSample,
} from './hosted-pressure-decision.ts'

const start = Date.parse('2026-10-30T12:00:00.000Z')
const sample = (
  overrides: Partial<HostedPressureSample> = {},
  at = start,
): HostedPressureSample => ({
  kind: 'sample',
  stealFraction: 0,
  throttleFraction: 0,
  balance: 100,
  apiP95Seconds: 0,
  at: new Date(at).toISOString(),
  ...overrides,
})

describe('hosted pressure decision', () => {
  for (const [measure, values] of [
    ['steal', { stealFraction: HOSTED_STEAL_THRESHOLD }],
    ['throttle', { throttleFraction: HOSTED_THROTTLE_THRESHOLD + 0.01 }],
    ['api-p95', { apiP95Seconds: HOSTED_API_P95_THRESHOLD_SECONDS }],
  ] as const) {
    test(`${measure} starts pressure at its threshold`, () => {
      const result = decideHostedPressure(CLEAR_HOSTED_PRESSURE_STATE, sample(values))
      expect(result.state).toMatchObject({ status: 'pressure', breachedMeasures: [measure] })
      expect(result.conditions).toEqual([
        expect.objectContaining({ kind: 'hosted-pressure', subject: 'hosted-record' }),
      ])
    })
  }

  test('clears only after fifteen minutes below and a breach restarts the window', () => {
    const pressured = decideHostedPressure(
      CLEAR_HOSTED_PRESSURE_STATE,
      sample({ stealFraction: 0.3 }),
    ).state
    const below = decideHostedPressure(pressured, sample({}, start + 60_000)).state
    expect(decideHostedPressure(below, sample({}, start + 15 * 60_000)).state.status).toBe(
      'pressure',
    )
    expect(
      decideHostedPressure(below, sample({}, start + 60_000 + HOSTED_PRESSURE_CLEAR_MS)).state
        .status,
    ).toBe('clear')
    const breachedAgain = decideHostedPressure(
      below,
      sample({ apiP95Seconds: 2 }, start + 11 * 60_000),
    ).state
    const belowAgain = decideHostedPressure(breachedAgain, sample({}, start + 12 * 60_000)).state
    expect(decideHostedPressure(belowAgain, sample({}, start + 26 * 60_000)).state.status).toBe(
      'pressure',
    )
    expect(decideHostedPressure(belowAgain, sample({}, start + 27 * 60_000)).state.status).toBe(
      'clear',
    )
  })

  test('keeps a stable subject while measures join and while below threshold', () => {
    const first = decideHostedPressure(CLEAR_HOSTED_PRESSURE_STATE, sample({ stealFraction: 0.2 }))
    const joined = decideHostedPressure(first.state, sample({ apiP95Seconds: 2 }, start + 60_000))
    const below = decideHostedPressure(joined.state, sample({}, start + 2 * 60_000))
    expect(joined.state.breachedMeasures).toEqual(['steal', 'api-p95'])
    expect([first, joined, below].map((result) => result.conditions[0]?.subject)).toEqual([
      'hosted-record',
      'hosted-record',
      'hosted-record',
    ])
    expect(below.conditions[0]?.detail).toContain('breached steal, api-p95')
  })

  test('absent optional VM series stay clear but required series report observation errors', () => {
    expect(
      decideHostedPressure(
        CLEAR_HOSTED_PRESSURE_STATE,
        sample({ throttleFraction: 'absent', balance: 'absent' }),
      ).conditions,
    ).toEqual([])
    for (const [series, missing] of [
      ['steal', { stealFraction: 'absent' as const }],
      ['api-p95', { apiP95Seconds: 'absent' as const }],
    ] as const) {
      expect(decideHostedPressure(CLEAR_HOSTED_PRESSURE_STATE, sample(missing)).conditions).toEqual(
        [
          expect.objectContaining({
            kind: 'observation-error',
            subject: `hosted-metrics:${series}`,
          }),
        ],
      )
    }
  })

  test('a present breach starts pressure beside an absent-series error', () => {
    const result = decideHostedPressure(
      CLEAR_HOSTED_PRESSURE_STATE,
      sample({ stealFraction: 0.9, apiP95Seconds: 'absent' }),
    )
    expect(result.state).toMatchObject({ status: 'pressure', breachedMeasures: ['steal'] })
    expect(result.conditions).toEqual([
      expect.objectContaining({ kind: 'hosted-pressure' }),
      expect.objectContaining({
        kind: 'observation-error',
        subject: 'hosted-metrics:api-p95',
      }),
    ])
  })

  test('a failed query during an episode keeps pressure beside the error', () => {
    const pressured = decideHostedPressure(
      CLEAR_HOSTED_PRESSURE_STATE,
      sample({ stealFraction: 0.3 }),
    ).state
    const result = decideHostedPressure(pressured, {
      kind: 'failed',
      query: 'api-p95',
      error: 'offline',
      at: new Date(start + 60_000).toISOString(),
    })
    expect(result.state).toEqual(pressured)
    expect(result.conditions.map(({ kind }) => kind)).toEqual([
      'hosted-pressure',
      'observation-error',
    ])
  })

  test('an absent required series does not complete an episode clear window', () => {
    const pressured = decideHostedPressure(
      CLEAR_HOSTED_PRESSURE_STATE,
      sample({ stealFraction: 0.3 }),
    ).state
    const clearing = decideHostedPressure(pressured, sample({}, start + 60_000)).state
    const result = decideHostedPressure(
      clearing,
      sample({ apiP95Seconds: 'absent' }, start + 60_000 + HOSTED_PRESSURE_CLEAR_MS),
    )
    expect(result.state).toEqual(clearing)
    expect(result.conditions.map(({ kind }) => kind)).toEqual([
      'hosted-pressure',
      'observation-error',
    ])
  })

  test('unconfigured metrics give the configured informational remedy', () => {
    expect(
      decideHostedPressure(CLEAR_HOSTED_PRESSURE_STATE, {
        kind: 'unconfigured',
        at: new Date(start).toISOString(),
      }).conditions,
    ).toEqual([
      expect.objectContaining({
        kind: 'hosted-metrics-unconfigured',
        severity: 'informational',
        action: `${PLATFORM_SLUG} machine config secret set BOTTEGA_FLY_METRICS_TOKEN`,
      }),
    ])
  })
})
