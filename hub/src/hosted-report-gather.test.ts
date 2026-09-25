import { expect, test } from 'bun:test'
import { gatherHostedReport, type HostedReportRow } from './hosted-report-gather.ts'

const period = {
  from: '2026-09-17T13:00:00.000Z',
  to: '2026-09-18T13:00:00.000Z',
  key: '2026-09-18T13:00:00.000Z',
}

const row = (patch: Partial<HostedReportRow> = {}): HostedReportRow => ({
  space_id: 'space-a',
  task_id: 'task-a',
  task_key: 'DEV-785',
  project_name: 'workshop',
  start_at: '2026-09-18T10:00:00.000Z',
  end_at: '2026-09-18T11:00:00.000Z',
  open: 0,
  vendor_tokens: 1_200,
  task_project: 'workshop',
  task_title: 'Restore the formatted report',
  task_status: 'done',
  project_color: '#654321',
  project_id: 'project-a',
  ...patch,
})

test('hosted report rows project task facts, unions and vendor tokens', () => {
  const gathered = gatherHostedReport(
    [
      row(),
      row({
        task_id: null,
        task_key: null,
        task_project: null,
        task_title: null,
        task_status: null,
        start_at: '2026-09-18T10:30:00.000Z',
        end_at: '2026-09-18T11:30:00.000Z',
        vendor_tokens: 999,
      }),
    ],
    new Set(['task-a']),
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
    color: '#654321',
    taskMs: 3_600_000,
    engagedMs: 5_400_000,
    shipped: 1,
    moving: 0,
    agentTokens: 2_199,
  })
  expect(gathered.engagedMs).toBe(5_400_000)
})

test('hosted reports group and close equal labels by task id', () => {
  const gathered = gatherHostedReport(
    [
      row({ task_id: 'task-a', space_id: 'space-a', vendor_tokens: 100 }),
      row({
        task_id: 'task-b',
        space_id: 'space-b',
        project_name: 'other-workshop',
        task_project: 'other-workshop',
        vendor_tokens: 200,
      }),
    ],
    new Set(['task-b']),
    period,
  )

  expect(gathered.items).toHaveLength(2)
  expect(gathered.items.map((item) => ({ project: item.project, closed: item.closed }))).toEqual([
    { project: 'workshop', closed: false },
    { project: 'other-workshop', closed: true },
  ])
})

test('hosted reports keep same-named projects in different spaces distinct', () => {
  const gathered = gatherHostedReport(
    [
      row({ task_id: 'task-a', space_id: 'space-a', project_id: 'project-a' }),
      row({ task_id: 'task-b', space_id: 'space-b', project_id: 'project-b' }),
    ],
    new Set(),
    period,
  )

  expect(gathered.projects).toHaveLength(2)
  expect(gathered.projects.map((project) => project.project)).toEqual(['workshop', 'workshop'])
})
