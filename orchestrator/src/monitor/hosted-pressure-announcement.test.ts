import { describe, expect, test } from 'bun:test'
import type { HostedBoardOverviewEntry } from '../record/record-board-contract.ts'
import {
  decideHostedPressureAnnouncement,
  HOSTED_PRESSURE_CLEARED_TITLE,
  HOSTED_PRESSURE_CLEARED_TTL_MS,
  HOSTED_PRESSURE_NOTICE_TTL_MS,
} from './hosted-pressure-announcement.ts'
import {
  CLEAR_HOSTED_PRESSURE_STATE,
  type HostedPressureObservation,
  type HostedPressureState,
} from './hosted-pressure-decision.ts'

const onset = '2026-10-30T12:00:00.000Z'
const pressure: HostedPressureState = {
  status: 'pressure',
  onsetAt: onset,
  belowSince: null,
  breachedMeasures: ['steal'],
}
const sample: HostedPressureObservation = {
  kind: 'sample',
  stealFraction: 0.25,
  throttleFraction: 0,
  balance: 50,
  apiP95Seconds: 0.5,
  at: onset,
}
const notice = (id: string, title: string) =>
  ({ id, title }) as Pick<HostedBoardOverviewEntry, 'id' | 'title'>

describe('hosted pressure announcement decision', () => {
  test('onset posts once only when no onset notice is open', () => {
    const posted = decideHostedPressureAnnouncement(
      CLEAR_HOSTED_PRESSURE_STATE,
      pressure,
      sample,
      [],
    )
    expect(posted).toEqual([
      {
        kind: 'post',
        notice: expect.objectContaining({
          title: 'Hosted pressure: steal=0.25',
          expiresMs: HOSTED_PRESSURE_NOTICE_TTL_MS,
        }),
      },
    ])
    expect(
      decideHostedPressureAnnouncement(CLEAR_HOSTED_PRESSURE_STATE, pressure, sample, [
        notice('onset', 'Hosted pressure: steal=0.2'),
      ]),
    ).toEqual([])
  })

  test('clear withdraws every onset notice and posts one short-lived clear notice', () => {
    for (const open of [
      [notice('one', 'Hosted pressure: steal=0.2')],
      [
        notice('one', 'Hosted pressure: steal=0.2'),
        notice('two', 'Hosted pressure: api-p95=3s'),
        notice('cleared', HOSTED_PRESSURE_CLEARED_TITLE),
      ],
    ]) {
      const actions = decideHostedPressureAnnouncement(
        pressure,
        CLEAR_HOSTED_PRESSURE_STATE,
        {
          ...sample,
          at: '2026-10-30T12:20:00.000Z',
        },
        open,
      )
      expect(
        actions.filter((action) => action.kind === 'withdraw').map((action) => action.id),
      ).toEqual(open.filter((item) => item.id !== 'cleared').map((item) => item.id))
      expect(actions.at(-1)).toEqual({
        kind: 'post',
        notice: {
          title: HOSTED_PRESSURE_CLEARED_TITLE,
          body: `Hosted pressure that began at ${onset} cleared at 2026-10-30T12:20:00.000Z.`,
          expiresMs: HOSTED_PRESSURE_CLEARED_TTL_MS,
        },
      })
    }
  })

  test('no transition, failed observations, and unconfigured observations do nothing', () => {
    expect(decideHostedPressureAnnouncement(pressure, pressure, sample, [])).toEqual([])
    for (const observation of [
      { kind: 'failed', query: 'steal', error: 'offline', at: onset },
      { kind: 'unconfigured', at: onset },
    ] as HostedPressureObservation[]) {
      expect(
        decideHostedPressureAnnouncement(CLEAR_HOSTED_PRESSURE_STATE, pressure, observation, []),
      ).toEqual([])
    }
  })
})
