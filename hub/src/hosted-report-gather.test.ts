import { expect, test } from 'bun:test'
import { gatherHostedReport, type HostedReportRow } from './hosted-report-gather.ts'

const period = {
  from: '2026-09-17T13:00:00.000Z',
  to: '2026-09-18T13:00:00.000Z',
  key: '2026-09-18T13:00:00.000Z',
}

const row = (patch: Partial<HostedReportRow> = {}): HostedReportRow => ({
  task_key: 'DEV-785',
  project_name: 'workshop',
  start_at: '2026-09-18T10:00:00.000Z',
  end_at: '2026-09-18T11:00:00.000Z',
  open: 0,
  vendor_tokens: 1_200,
  task_project: 'workshop',
  task_title: 'Restore the formatted report',
  task_status: 'done',
  ...patch,
})

test('hosted report rows project task facts, unions and vendor tokens', () => {
  const gathered = gatherHostedReport(
    [
      row(),
      row({
        task_key: null,
        task_project: null,
        task_title: null,
        task_status: null,
        start_at: '2026-09-18T10:30:00.000Z',
        end_at: '2026-09-18T11:30:00.000Z',
        vendor_tokens: 999,
      }),
    ],
    new Set(['DEV-785']),
    period,
  )

  expect(gathered.items[0]).toMatchObject({
    key: 'DEV-785',
    project: 'workshop',
    title: 'Restore the formatted report',
    closed: true,
    engagedMs: 3_600_000,
    agentTokens: 1_200,
  })
  expect(gathered.projects[0]).toMatchObject({
    taskMs: 3_600_000,
    engagedMs: 5_400_000,
    shipped: 1,
    moving: 0,
    agentTokens: 2_199,
  })
  expect(gathered.engagedMs).toBe(5_400_000)
})
