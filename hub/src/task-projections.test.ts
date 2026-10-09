import { expect, test } from 'bun:test'
import {
  projectBoardCards,
  projectFlightDone,
  projectRatioSummary,
  projectRollUpDays,
  projectSpendGrid,
  projectTasksInWindow,
  type WindowIntervalRow,
} from './task-projections.ts'

const DAY_TOKENS = 8_338_668_790

function expectNumber(value: unknown, expected: number) {
  expect(typeof value).toBe('number')
  expect(value).toBe(expected)
}

const now = Date.parse('2026-09-17T12:00:00.000Z')
const project = [{ name: 'workshop', settings: { keyPrefixes: ['DEV'] } }]
const row: WindowIntervalRow = {
  task_key: 'DEV-701',
  project: 'workshop',
  source: 'orch',
  agent: 'codex',
  job: 'implementation',
  start_at: '2026-09-17T10:00:00.000Z',
  end_at: '2026-09-17T11:00:00.000Z',
  claude_tokens: 10,
  vendor_tokens: 20,
  vendor_cost_usd: 0.25,
  open: 0,
  task_project: 'workshop',
  task_title: 'Hosted work pages',
  task_status: 'active',
  task_status_category: 'active',
  task_source: 'local',
  task_updated_at: '2026-09-17T11:00:00.000Z',
  task_closed_at: null,
}

test('the shared window and flight projections give both adapters one rendered shape', () => {
  const sqliteRows = [{ ...row }]
  const postgresRows = [{ ...row }]
  const local = projectTasksInWindow(sqliteRows, project, now)
  const hosted = projectTasksInWindow(postgresRows, project, now)
  expect(hosted).toEqual(local)
  const input = {
    name: 'flight' as const,
    completed: [],
    intervals: [row],
    filters: { agent: '', project: '', source: '' },
    projects: project,
    now,
  }
  expect(projectFlightDone({ ...input, tasks: hosted })).toEqual(
    projectFlightDone({ ...input, tasks: local }),
  )
  expect(hosted[0]).toMatchObject({ key: 'DEV-701', engagedMs: 3_600_000, workingNow: false })
})

test('day, ratio and spend projections give both adapters one rendered shape', () => {
  const sourceRows = [
    { source: 'claude', start_at: '2026-09-15T10:00:00.000Z', claude_tokens: 100 },
    { source: 'codex', start_at: '2026-09-15T11:00:00.000Z', claude_tokens: 200 },
  ]
  expect(projectRollUpDays(sourceRows)).toEqual([{ day: '2026-09-15', claude: 300, msgs: 2 }])
  const days = [
    {
      day: '2026-09-15',
      claude_tokens: 300,
      tasks: 2,
      commits: 1,
      files: 3,
      lines_product: 10,
      lines_test: 4,
      lines_docs: 2,
      lines_config: 1,
      lines_generated: 0,
    },
  ]
  const intervals = [
    { start_at: '2026-09-15T10:00:00.000Z', end_at: '2026-09-15T11:00:00.000Z', open: 0 },
  ]
  const local = projectRatioSummary(days, intervals, now)
  const hosted = projectRatioSummary(
    days.map((day) => ({ ...day })),
    intervals.map((row) => ({ ...row })),
    now,
  )
  expect(hosted).toEqual(local)
  expect(
    projectSpendGrid(hosted, [{ agent: 'codex', tokens: 50, cost: 0.2 }], intervals, now),
  ).toEqual(projectSpendGrid(local, [{ agent: 'codex', tokens: 50, cost: 0.2 }], intervals, now))
})

test('board bucketing fields and live state are shaped outside either database adapter', () => {
  const cards = projectBoardCards(
    [
      {
        record_id: 'task-record-701',
        key: 'DEV-701',
        project: 'workshop',
        title: 'Hosted work pages',
        assignee: null,
        status: 'active',
        status_category: 'active',
        source: 'local',
        updated_at: null,
        last_seen: '2026-09-17T11:00:00.000Z',
      },
    ],
    ['task-record-701'],
    project,
  )
  expect(cards[0]).toMatchObject({
    key: 'DEV-701',
    statusCategory: 'active',
    updatedAt: '2026-09-17T11:00:00.000Z',
    workingNow: true,
  })
})

test('lens projections keep duplicate task keys separate and label their spaces', () => {
  const rows = [
    { ...row, space_id: 'space-a', space_name: 'Personal' },
    { ...row, space_id: 'space-b', space_name: 'Workshop' },
  ]
  const tasks = projectTasksInWindow(rows, project, now)
  expect(tasks).toHaveLength(2)
  expect(tasks.map(({ spaceId, spaceName }) => ({ spaceId, spaceName }))).toEqual([
    { spaceId: 'space-a', spaceName: 'Personal' },
    { spaceId: 'space-b', spaceName: 'Workshop' },
  ])
})

test('local projection keeps one shared label separate by task record id', () => {
  const tasks = projectTasksInWindow(
    [
      { ...row, task_record_id: 'alpha-record', project: 'alpha', task_project: 'alpha' },
      { ...row, task_record_id: 'beta-record', project: 'beta', task_project: 'beta' },
    ],
    project,
    now,
  )
  expect(tasks.map(({ recordId, project }) => ({ recordId, project }))).toEqual([
    { recordId: 'alpha-record', project: 'alpha' },
    { recordId: 'beta-record', project: 'beta' },
  ])
})

test('ratio summary returns day token totals above the 32-bit range as a number', () => {
  const startAt = '2026-10-05T10:00:00.000Z'
  const endAt = '2026-10-05T12:00:00.000Z'
  const ratio = projectRatioSummary(
    [
      {
        day: '2026-10-05',
        claude_tokens: DAY_TOKENS,
        tasks: 1,
        commits: 0,
        files: 0,
        lines_product: 0,
        lines_test: 0,
        lines_docs: 0,
        lines_config: 0,
        lines_generated: 0,
      },
    ],
    [{ start_at: startAt, end_at: endAt, open: 0 }],
    Date.parse('2026-10-09T00:00:00.000Z'),
  )
  expectNumber(ratio.tokens, DAY_TOKENS)
})
