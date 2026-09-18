import { describe, expect, test } from 'bun:test'
import type { Measures } from './measures.ts'
import type { GatheredReport } from './report.ts'
import {
  type DeliveryCandidate,
  type DeliveryRepository,
  type DeliverySubscription,
  duePeriod,
  renderReport,
  runReportDeliveryPass,
} from './report-delivery.ts'
import { sesReportMailClient } from './report-delivery-hosted.ts'

const now = new Date('2026-09-18T13:30:00.000Z') // 09:30 America/New_York
const candidate = (id: string): DeliveryCandidate => ({
  subscriptionId: id,
  spaceId: `01990000-0000-7000-8000-${id.padStart(12, '0')}`,
  cadence: 'daily',
  hour: 9,
  weekday: null,
  zone: 'America/New_York',
  createdAt: '2026-09-16T12:00:00.000Z',
  lastPeriodEnd: null,
})

const workMeasures: Measures = {
  scope: 'space',
  hoursRunning: {
    notAdditive: true,
    unionMs: 23 * 3_600_000,
    sample: { intervalCount: 4 },
    from: { startedIntervals: 2, sessionIntervals: 2 },
  },
  agentHours: {
    from: 'started',
    sumMs: 77 * 3_600_000,
    sample: { intervalCount: 2 },
    unknownShare: { intervalCount: 1, sumMs: 2 * 3_600_000 },
  },
  sessionTime: {
    from: 'session',
    unionThenSumMs: 3 * 3_600_000,
    uncountedSilenceMs: 45 * 60_000,
    sample: { intervalCount: 2, userCount: 1 },
    silenceAllowanceMs: 600_000,
    silenceAllowanceSentence: 'Silences longer than ten minutes are not counted.',
    unknownUser: { unionThenSumMs: 0, uncountedSilenceMs: 0, sample: { intervalCount: 0 } },
  },
  cost: {
    from: 'started',
    vendorCostUsd: 12.34,
    vendorTokens: 1_000,
    sample: { intervalCount: 2 },
    unknownShare: { vendorCostUsd: 1, vendorTokens: 100, intervalCount: 1 },
  },
  shipped: { count: 2, sample: { taskCount: 2, eventCount: 2 } },
  cycleTime: { medianMs: 5 * 3_600_000, p90Ms: 8 * 3_600_000, n: 2 },
}

const emptyMeasures: Measures = {
  scope: 'space',
  hoursRunning: {
    notAdditive: true,
    unionMs: 0,
    sample: { intervalCount: 0 },
    from: { startedIntervals: 0, sessionIntervals: 0 },
  },
  agentHours: {
    from: 'started',
    sumMs: 0,
    sample: { intervalCount: 0 },
    unknownShare: { intervalCount: 0, sumMs: 0 },
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
    vendorCostUsd: 0,
    vendorTokens: 0,
    sample: { intervalCount: 0 },
    unknownShare: { vendorCostUsd: 0, vendorTokens: 0, intervalCount: 0 },
  },
  shipped: { count: 0, sample: { taskCount: 0, eventCount: 0 } },
}

const measures = (work = true) => (work ? workMeasures : emptyMeasures)

const gatheredReport = (): GatheredReport => {
  const items = [
    { key: 'DEV-785', title: 'Restore the formatted report', closed: true, agentTokens: 1_200 },
    {
      key: 'DEV-786',
      title: 'Keep number spelling consistent',
      closed: false,
      agentTokens: 3_400_000,
    },
    { key: 'DEV-787', title: 'Exercise large totals', closed: false, agentTokens: 1_100_000_000 },
    { key: 'DEV-788', title: 'Keep small totals plain', closed: false, agentTokens: 999 },
  ].map((item) => ({
    ...item,
    project: 'workshop',
    status: item.closed ? 'done' : 'active',
    engaged: '1h 0m',
    engagedMs: 3_600_000,
  }))
  return {
    from: '2026-09-17T13:00:00.000Z',
    to: '2026-09-18T13:00:00.000Z',
    hours: 24,
    items,
    taskMs: 4 * 3_600_000,
    engagedMs: 3_600_000,
    projects: [
      {
        project: 'workshop',
        taskMs: 4 * 3_600_000,
        engagedMs: 3_600_000,
        shipped: 1,
        moving: 3,
        agentTokens: items.reduce((sum, item) => sum + item.agentTokens, 0),
        items,
        untasked: null,
      },
    ],
  }
}

const subscription = (patch: Partial<DeliverySubscription> = {}): DeliverySubscription => ({
  recipientUserId: '01990000-0000-7000-8000-000000000701',
  recipientName: 'Maya',
  recipientEmail: 'maya@example.test',
  recipientIsMember: true,
  scope: { kind: 'space' },
  scopeName: 'Workshop',
  measures: measures(),
  report: gatheredReport(),
  ...patch,
})

function fakeRepository(
  candidates: DeliveryCandidate[],
  load: (value: DeliveryCandidate) => Promise<DeliverySubscription>,
) {
  const rows: { subscription: string; status: string; reason?: string }[] = []
  const used = new Set<string>()
  const repository: DeliveryRepository = {
    async discover() {
      return candidates
    },
    load,
    async recipientIsMember(value, userId) {
      return (await load(value)).recipientIsMember && Boolean(userId)
    },
    async recordFinal(value, period, input) {
      const key = `${value.subscriptionId}:${period.key}`
      if (used.has(key)) return
      used.add(key)
      rows.push({ subscription: value.subscriptionId, status: input.status, reason: input.reason })
    },
    async recordIntent(value, period) {
      const key = `${value.subscriptionId}:${period.key}`
      if (used.has(key)) return null
      used.add(key)
      rows.push({ subscription: value.subscriptionId, status: 'pending' })
      return key
    },
    async recordOutcome(_value, id, status, reason) {
      const row = rows.find(
        (item) =>
          `${item.subscription}:${duePeriod(candidate(item.subscription), now)?.key}` === id,
      )!
      row.status = status
      row.reason = reason
    },
  }
  return { repository, rows }
}

describe('hosted report delivery', () => {
  test('a due subscription renders and sends once; the second pass sends nothing', async () => {
    const value = candidate('1')
    const fake = fakeRepository([value], async () => subscription())
    const sent: { to: string; text: string; html: string }[] = []
    const mail = {
      async send(input: { to: string; text: string; html: string }) {
        sent.push(input)
      },
    }
    await runReportDeliveryPass({ repository: fake.repository, mail, now })
    await runReportDeliveryPass({ repository: fake.repository, mail, now })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.to).toBe('maya@example.test')
    expect(sent[0]!.html).toContain('<!doctype html>')
    expect(sent[0]!.text).not.toBe(sent[0]!.html)
    expect(fake.rows).toEqual([{ subscription: '1', status: 'sent', reason: undefined }])
  })

  test('an empty scope records a skipped reason and sends nothing', async () => {
    const fake = fakeRepository([candidate('2')], async () =>
      subscription({ measures: measures(false) }),
    )
    let sent = 0
    await runReportDeliveryPass({
      repository: fake.repository,
      mail: {
        async send() {
          sent++
        },
      },
      now,
    })
    expect(sent).toBe(0)
    expect(fake.rows[0]).toMatchObject({
      status: 'skipped',
      reason: 'scope had no recorded work in this period',
    })
  })

  test('one subscription failure is recorded and does not stop another', async () => {
    const fake = fakeRepository([candidate('3'), candidate('4')], async (value) => {
      if (value.subscriptionId === '3') throw new Error('render facts unavailable')
      return subscription()
    })
    const sent: string[] = []
    await runReportDeliveryPass({
      repository: fake.repository,
      mail: {
        async send(input) {
          sent.push(input.to)
        },
      },
      now,
    })
    expect(sent).toHaveLength(1)
    expect(fake.rows).toEqual([
      { subscription: '3', status: 'failed', reason: 'render facts unavailable' },
      { subscription: '4', status: 'sent', reason: undefined },
    ])
  })

  test('a departed recipient is skipped and rechecked immediately before sending', async () => {
    let checks = 0
    const fake = fakeRepository([candidate('5')], async () => subscription())
    fake.repository.recipientIsMember = async () => ++checks < 1
    let sent = 0
    await runReportDeliveryPass({
      repository: fake.repository,
      mail: {
        async send() {
          sent++
        },
      },
      now,
    })
    expect(sent).toBe(0)
    expect(fake.rows[0]).toMatchObject({
      status: 'skipped',
      reason: 'recipient is no longer a member of this space',
    })
  })

  test('mail states the local window and honest measures without refused metrics', () => {
    const value = candidate('6')
    const period = duePeriod(value, now)!
    const rendered = renderReport(value, period, subscription())
    expect(rendered.text).toContain(
      'Window: Sep 17, 2026 9:00 AM to Sep 18, 2026 9:00 AM (America/New_York)',
    )
    expect(rendered.text).toContain('Agents ran for 77 agent-hours.')
    expect(rendered.text).toContain('Silences longer than ten minutes are not counted.')
    expect(rendered.text).toContain('0.8 hours of silence was uncounted.')
    expect(rendered.text).toContain('2 agent-hours had unknown attribution.')
    expect(rendered.text).toContain('Median cycle time was 5 hours across 2 items.')
    expect(rendered.text).toContain('BY PROJECT')
    expect(rendered.text).toContain('DEV-785 · 1h 0m engaged · 1.2K agent tokens')
    expect(rendered.text).toContain('Restore the formatted report')
    expect(rendered.text).toContain('3.4M agent tokens')
    expect(rendered.text).toContain('1.1B agent tokens')
    expect(rendered.text).toContain('999 agent tokens')
    expect(rendered.text).not.toContain('agent sentence')
    expect(rendered.html).toContain('Restore the formatted report')
    expect(rendered.html).toContain('This measure is not additive.')
    expect(rendered.html).toContain('Silences longer than ten minutes are not counted.')
    expect(rendered.text.toLowerCase()).not.toMatch(/ranking|composite|lines per|spent|worked/)
  })

  test('a failure after dispatch leaves the intent as failed, not clean', async () => {
    const fake = fakeRepository([candidate('7')], async () => subscription())
    let dispatched = false
    await runReportDeliveryPass({
      repository: fake.repository,
      mail: {
        async send() {
          dispatched = true
          throw new Error('SES response was lost')
        },
      },
      now,
    })
    expect(dispatched).toBe(true)
    expect(fake.rows[0]).toMatchObject({ status: 'failed', reason: 'SES response was lost' })
  })

  test('dry-run prints rendered mail without sending or recording', async () => {
    const fake = fakeRepository([candidate('8')], async () => subscription())
    const printed: string[] = []
    let sent = 0
    await runReportDeliveryPass({
      repository: fake.repository,
      mail: {
        async send() {
          sent++
        },
      },
      now,
      dryRun: true,
      print: (value) => printed.push(value),
    })
    expect(sent).toBe(0)
    expect(fake.rows).toHaveLength(0)
    expect(printed[0]).toContain('To: maya@example.test')
  })

  test('the first period starts at subscription creation and DST periods do not drift', () => {
    const first = { ...candidate('9'), createdAt: '2026-09-18T12:30:00.000Z' }
    expect(duePeriod(first, now)?.from).toBe('2026-09-18T12:30:00.000Z')
    const spring = duePeriod(candidate('10'), new Date('2027-03-14T14:00:00.000Z'))!
    expect(new Date(spring.to).getTime() - new Date(spring.from).getTime()).toBe(23 * 3_600_000)
  })

  test('SES is injected in tests and addresses only the subscription recipient', async () => {
    const commands: unknown[] = []
    const environment = {
      SES_REGION: 'us-east-2',
      SES_FROM_ADDRESS: 'Reports <reports@example.test>',
      SES_ACCESS_KEY_ID: 'FAKEACCESSKEYFORTEST',
      SES_SECRET_ACCESS_KEY: 'fake-secret-for-test-only',
    }
    await sesReportMailClient(environment, {
      async send(command) {
        commands.push(command)
      },
    }).send({ to: 'maya@example.test', subject: 'Report', text: 'text', html: '<p>text</p>' })
    expect(commands).toHaveLength(1)
    expect(
      (commands[0] as { input: { Destination: { ToAddresses: string[] } } }).input.Destination
        .ToAddresses,
    ).toEqual(['maya@example.test'])
    await expect(
      sesReportMailClient(environment).send({
        to: 'maya@example.test',
        subject: 'Report',
        text: 'text',
        html: '<p>text</p>',
      }),
    ).rejects.toThrow('report mailer refuses a real SES client under the test runner')
  })
})
