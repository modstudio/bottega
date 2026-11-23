import { describe, expect, test } from 'bun:test'
import type { HostedBoardOverviewEntry } from '../record/record-board-contract.ts'
import {
  COLLECTOR_LEG_FAILURE_NOTICE_THRESHOLD_MS,
  decideStandingConditionAnnouncement,
  OUTBOX_QUARANTINED_NOTICE_THRESHOLD_MS,
  RECORD_TUNNEL_DOWN_NOTICE_THRESHOLD_MS,
  STANDING_CONDITION_DETAIL_LINE_CHARS,
  STANDING_CONDITION_NOTICE_PREFIX,
  STANDING_CONDITION_NOTICE_TTL_MS,
  type StandingConditionCandidate,
} from './standing-condition-announcement.ts'

const candidate = (
  kind: StandingConditionCandidate['condition']['kind'],
  subject: string,
  persistedMs: number,
  detail = 'first line\nprivate follow-up detail',
): StandingConditionCandidate => ({
  condition: { kind, subject, detail, action: `repair ${kind}` },
  onset: '2026-11-22T12:00:00.000Z',
  persistedMs,
})
const notice = (id: string, title: string) =>
  ({ id, title }) as Pick<HostedBoardOverviewEntry, 'id' | 'title'>

describe('standing condition announcement decision', () => {
  test('a transient condition under its threshold posts nothing', () => {
    expect(
      decideStandingConditionAnnouncement(
        [candidate('record-tunnel-down', 'record', RECORD_TUNNEL_DOWN_NOTICE_THRESHOLD_MS - 1)],
        [],
      ),
    ).toEqual([])
  })

  test('a persistent condition posts once with a bounded first detail line', () => {
    const detail = `${'x'.repeat(STANDING_CONDITION_DETAIL_LINE_CHARS + 20)}\nnot included`
    const actions = decideStandingConditionAnnouncement(
      [candidate('record-tunnel-down', 'record', RECORD_TUNNEL_DOWN_NOTICE_THRESHOLD_MS, detail)],
      [],
    )
    expect(actions).toEqual([
      {
        kind: 'post',
        notice: expect.objectContaining({
          title: `${STANDING_CONDITION_NOTICE_PREFIX} record-tunnel-down`,
          expiresMs: STANDING_CONDITION_NOTICE_TTL_MS,
        }),
      },
    ])
    const body = actions[0]?.kind === 'post' ? actions[0].notice.body : ''
    expect(body).toContain(`${'x'.repeat(STANDING_CONDITION_DETAIL_LINE_CHARS - 1)}…`)
    expect(body).not.toContain('not included')
    expect(body).toContain('Remedy: repair record-tunnel-down')
  })

  test('an already-open notice does not post again', () => {
    const title = `${STANDING_CONDITION_NOTICE_PREFIX} record-tunnel-down`
    expect(
      decideStandingConditionAnnouncement(
        [candidate('record-tunnel-down', 'record', RECORD_TUNNEL_DOWN_NOTICE_THRESHOLD_MS)],
        [notice('open', title)],
      ),
    ).toEqual([])
  })

  test('recovery withdraws the open notice', () => {
    expect(
      decideStandingConditionAnnouncement(
        [],
        [notice('open', `${STANDING_CONDITION_NOTICE_PREFIX} record-tunnel-down`)],
      ),
    ).toEqual([{ kind: 'withdraw', id: 'open' }])
  })

  test('collector legs retain independent notices under the shared prefix', () => {
    const runsTitle = `${STANDING_CONDITION_NOTICE_PREFIX} collector leg runs`
    expect(
      decideStandingConditionAnnouncement(
        [
          candidate('collector-leg-failure', 'runs', COLLECTOR_LEG_FAILURE_NOTICE_THRESHOLD_MS),
          candidate(
            'collector-leg-failure',
            'hosted-changes',
            COLLECTOR_LEG_FAILURE_NOTICE_THRESHOLD_MS,
          ),
        ],
        [notice('runs', runsTitle)],
      ),
    ).toEqual([
      {
        kind: 'post',
        notice: expect.objectContaining({
          title: `${STANDING_CONDITION_NOTICE_PREFIX} collector leg hosted-changes`,
        }),
      },
    ])
  })

  test('several conditions of one kind count the group and name the oldest', () => {
    const actions = decideStandingConditionAnnouncement(
      [
        candidate('outbox-quarantined', 'outbox:2', OUTBOX_QUARANTINED_NOTICE_THRESHOLD_MS),
        candidate('outbox-quarantined', 'outbox:1', OUTBOX_QUARANTINED_NOTICE_THRESHOLD_MS + 1),
      ],
      [],
    )
    const body = actions[0]?.kind === 'post' ? actions[0].notice.body : ''
    expect(body).toContain('2 live outbox-quarantined conditions; oldest outbox:1')
  })

  test('another prefix is ignored', () => {
    expect(
      decideStandingConditionAnnouncement(
        [candidate('record-tunnel-down', 'record', RECORD_TUNNEL_DOWN_NOTICE_THRESHOLD_MS)],
        [notice('other', 'Another monitor: record-tunnel-down')],
      ),
    ).toHaveLength(1)
  })

  test('an unlisted ownerless kind never posts', () => {
    expect(
      decideStandingConditionAnnouncement(
        [
          {
            condition: {
              kind: 'orphan-sandbox-dir',
              subject: 'sandbox',
              detail: 'orphan',
              action: 'inspect',
            },
            onset: '2026-11-22T12:00:00.000Z',
            persistedMs: 24 * 60 * 60_000,
          } as unknown as StandingConditionCandidate,
        ],
        [],
      ),
    ).toEqual([])
  })
})
