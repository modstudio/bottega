import { expect, test } from 'bun:test'
import {
  asHostedReportRow,
  gatherHostedReport,
  type HostedReportRow,
} from './hosted-report-gather.ts'
import {
  projectDisplayNames,
  projectItemPresentation,
  renderHtml,
  renderText,
} from './report-renderer.ts'

const INTERVAL_TOKENS = 2_207_932_949

function expectNumber(value: unknown, expected: number) {
  expect(typeof value).toBe('number')
  expect(value).toBe(expected)
}

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

test('hosted reports label duplicate project names with their spaces in both report parts', () => {
  const gathered = gatherHostedReport(
    [
      row({
        task_id: 'task-a',
        space_id: 'space-a',
        space_name: 'Alpha space',
        project_id: 'project-a',
      }),
      row({
        task_id: 'task-b',
        task_key: 'DEV-786',
        space_id: 'space-b',
        space_name: 'Beta space',
        project_id: 'project-b',
      }),
      row({
        task_id: 'task-c',
        task_key: 'DEV-787',
        project_name: 'distinct',
        task_project: 'distinct',
        space_id: 'space-b',
        space_name: 'Beta space',
        project_id: 'project-c',
      }),
    ],
    new Set(),
    period,
  )

  expect(gathered.projects).toHaveLength(3)
  expect(gathered.projects.map((project) => project.spaceName)).toEqual([
    'Alpha space',
    'Beta space',
    'Beta space',
  ])
  expect(projectDisplayNames(gathered.projects)).toEqual([
    'workshop (Alpha space)',
    'workshop (Beta space)',
    'distinct',
  ])
  const text = renderText(gathered, new Map())
  const html = renderHtml(gathered, new Map())
  expect(text).toContain('workshop (Alpha space)')
  expect(text).toContain('WORKSHOP (ALPHA SPACE)')
  expect(text).toContain('workshop (Beta space)')
  expect(text).toContain('WORKSHOP (BETA SPACE)')
  expect(text).not.toContain('distinct (Beta space)')
  expect(html.match(/workshop \(Alpha space\)/g)).toHaveLength(2)
  expect(html.match(/workshop \(Beta space\)/g)).toHaveLength(2)
  expect(html.match(/>distinct</g)).toHaveLength(2)
  expect(html).not.toContain('distinct (Beta space)')
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
  expect(gathered).toMatchObject({ taskMs: 21_600_000 })
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

  expect(gathered).toMatchObject({ taskMs: 7_200_000, engagedMs: 7_200_000 })
  expect(gathered.projects[0]).toMatchObject({
    taskMs: 7_200_000,
    engagedMs: 7_200_000,
    shipped: 1,
    moving: 0,
    unmatched: 1,
    untasked: { key: null, engagedMs: 3_600_000 },
  })
  const presentation = projectItemPresentation(gathered.projects[0]!.items)
  expect(presentation.done.map((item) => item.key)).toEqual(['DEV-785'])
  expect(presentation.open).toEqual([])
  expect(presentation.unmatched.map((item) => item.key)).toEqual(['DEV-404'])
  expect(presentation.displayItems.map(({ label }) => label)).toEqual([
    'Restore the formatted report',
    'DEV-404 — not in the task record',
  ])
  expect(presentation.unmatchedNotice).toBe('1 task was not found in the task record: DEV-404')
})

test('hosted report rows return vendor tokens above the 32-bit range as numbers', () => {
  const startAt = '2026-10-05T10:00:00.000Z'
  const endAt = '2026-10-05T12:00:00.000Z'
  const row = {
    space_id: '01990000-0000-7000-8000-000000001400',
    task_id: null,
    task_key: 'DEV-1240',
    project_name: 'workshop',
    start_at: startAt,
    end_at: endAt,
    open: 0,
    task_project: 'workshop',
    task_title: null,
    task_status: null,
    project_color: null,
  }
  const fromString = asHostedReportRow({ ...row, vendor_tokens: String(INTERVAL_TOKENS) })
  expectNumber(fromString.vendor_tokens, INTERVAL_TOKENS)
  expectNumber(
    asHostedReportRow({ ...row, vendor_tokens: INTERVAL_TOKENS }).vendor_tokens,
    INTERVAL_TOKENS,
  )
  const gathered = gatherHostedReport([fromString], new Set(), {
    from: startAt,
    to: endAt,
    key: endAt,
  })
  expectNumber(gathered.projects[0]!.agentTokens, INTERVAL_TOKENS)
})
