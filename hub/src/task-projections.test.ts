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
    ['DEV-701'],
    project,
  )
  expect(cards[0]).toMatchObject({
    key: 'DEV-701',
    statusCategory: 'active',
    updatedAt: '2026-09-17T11:00:00.000Z',
    workingNow: true,
  })
})
