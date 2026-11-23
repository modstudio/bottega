import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { HostedBoardOverviewEntry } from '../record/record-board-contract.ts'
import {
  COLLECTOR_LEG_ERROR_LINE_CHARS,
  COLLECTOR_LEG_FAILURE_NOTICE_PREFIX,
  COLLECTOR_LEG_FAILURE_NOTICE_TTL_MS,
  decideCollectorLegFailureAnnouncement,
} from './collector-leg-announcement.ts'
import type { CollectorLegFailure } from './collector-leg-conditions.ts'

const failure = (
  source: string,
  lastError = 'record query failed\nprivate follow-up detail',
): CollectorLegFailure => ({
  source,
  failingSince: '2026-11-22T12:00:00.000Z',
  ageMs: 18 * 60 * 60_000,
  lastError,
})
const notice = (id: string, title: string) =>
  ({ id, title }) as Pick<HostedBoardOverviewEntry, 'id' | 'title'>

describe('collector leg failure announcement decision', () => {
  test('onset posts once with a bounded first error line', () => {
    const longError = `${'x'.repeat(COLLECTOR_LEG_ERROR_LINE_CHARS + 20)}\nnot included`
    const actions = decideCollectorLegFailureAnnouncement(
      [failure('hosted-changes', longError)],
      [],
    )

    expect(actions).toEqual([
      {
        kind: 'post',
        notice: expect.objectContaining({
          title: `${COLLECTOR_LEG_FAILURE_NOTICE_PREFIX} hosted-changes`,
          expiresMs: COLLECTOR_LEG_FAILURE_NOTICE_TTL_MS,
        }),
      },
    ])
    const body = actions[0]?.kind === 'post' ? actions[0].notice.body : ''
    expect(body).toContain('failed for 1080 minutes')
    expect(body).toContain(`${'x'.repeat(COLLECTOR_LEG_ERROR_LINE_CHARS - 1)}…`)
    expect(body).not.toContain('not included')
    expect(body).toContain(`${PLATFORM_SLUG} record collector-legs --json`)
  })

  test('an already-open notice does not post again', () => {
    expect(
      decideCollectorLegFailureAnnouncement(
        [failure('hosted-changes')],
        [notice('open', `${COLLECTOR_LEG_FAILURE_NOTICE_PREFIX} hosted-changes`)],
      ),
    ).toEqual([])
  })

  test('recovery withdraws the open notice', () => {
    expect(
      decideCollectorLegFailureAnnouncement(
        [],
        [notice('open', `${COLLECTOR_LEG_FAILURE_NOTICE_PREFIX} hosted-changes`)],
      ),
    ).toEqual([{ kind: 'withdraw', id: 'open' }])
  })

  test('two legs are handled independently', () => {
    expect(
      decideCollectorLegFailureAnnouncement(
        [failure('runs'), failure('hosted-changes')],
        [notice('runs', `${COLLECTOR_LEG_FAILURE_NOTICE_PREFIX} runs`)],
      ),
    ).toEqual([
      {
        kind: 'post',
        notice: expect.objectContaining({
          title: `${COLLECTOR_LEG_FAILURE_NOTICE_PREFIX} hosted-changes`,
        }),
      },
    ])
  })

  test('an expired notice for a still-failing leg is posted again', () => {
    expect(decideCollectorLegFailureAnnouncement([failure('runs')], [])).toEqual([
      {
        kind: 'post',
        notice: expect.objectContaining({ title: `${COLLECTOR_LEG_FAILURE_NOTICE_PREFIX} runs` }),
      },
    ])
  })

  test('an open notice with another prefix is ignored', () => {
    expect(
      decideCollectorLegFailureAnnouncement(
        [failure('runs')],
        [notice('other', 'Another monitor: runs')],
      ),
    ).toEqual([
      {
        kind: 'post',
        notice: expect.objectContaining({ title: `${COLLECTOR_LEG_FAILURE_NOTICE_PREFIX} runs` }),
      },
    ])
  })
})
