import { expect, test } from 'bun:test'
import { gatherHostedReport, type HostedReportRow } from './hosted-report-gather.ts'
import { renderHtml, renderText } from './report-renderer.ts'

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

test('hosted reports keep unmatched task keys separate and union each key', () => {
  const keys = ['STO-1196', 'STO-1197', 'STO-716', 'STO-1198']
  const gathered = gatherHostedReport(
    keys.flatMap((task_key) => [
      row({
        task_id: null,
        task_key,
        task_project: null,
        task_title: null,
        task_status: null,
      }),
      row({
        task_id: null,
        task_key,
        task_project: null,
        task_title: null,
        task_status: null,
        start_at: '2026-09-18T10:30:00.000Z',
        end_at: '2026-09-18T11:30:00.000Z',
      }),
    ]),
    new Set(),
    period,
  )

  expect(gathered.items.map((item) => item.key)).toEqual(keys)
  expect(gathered.items.every((item) => item.unmatched)).toBeTrue()
  expect(gathered.items.every((item) => item.title === null && item.status === null)).toBeTrue()
  expect(gathered.items.map((item) => item.engagedMs)).toEqual(keys.map(() => 5_400_000))
  expect(gathered).toMatchObject({ taskMs: 21_600_000, unmatched: 4 })
  expect(gathered.projects[0]).toMatchObject({
    taskMs: 21_600_000,
    shipped: 0,
    moving: 0,
    unmatched: 4,
  })

  const text = renderText(gathered, new Map())
  const html = renderHtml(gathered, new Map())
  for (const rendered of [text, html]) {
    expect(rendered).toContain('4 tasks were not found in the task record')
    for (const key of keys) expect(rendered).toContain(key)
  }
  expect(text).toContain('STO-1196 — not in the task record')
  expect(html).toContain('STO-1196 — not in the task record')
  expect(text).toStartWith('6.0h of task work in 1.5h engaged · 0 done · 0 in progress')
})

test('hosted reports count matched, unmatched and untasked work independently', () => {
  const gathered = gatherHostedReport(
    [
      row(),
      row({
        task_id: null,
        task_key: 'DEV-404',
        task_project: null,
        task_title: null,
        task_status: null,
        start_at: '2026-09-18T10:30:00.000Z',
        end_at: '2026-09-18T11:30:00.000Z',
      }),
      row({
        task_id: null,
        task_key: null,
        task_project: null,
        task_title: null,
        task_status: null,
        start_at: '2026-09-18T11:00:00.000Z',
        end_at: '2026-09-18T12:00:00.000Z',
      }),
    ],
    new Set(['task-a']),
    period,
  )

  expect(gathered).toMatchObject({ taskMs: 7_200_000, engagedMs: 7_200_000, unmatched: 1 })
  expect(gathered.projects[0]).toMatchObject({
    taskMs: 7_200_000,
    engagedMs: 7_200_000,
    shipped: 1,
    moving: 0,
    unmatched: 1,
    untasked: { key: null, engagedMs: 3_600_000 },
  })
})
