import { expect, test } from 'bun:test'
import {
  type BoardSourceRow,
  combineMachineDays,
  projectBoard,
  projectBoardCards,
  projectFlightDone,
  projectRatioSummary,
  projectRollUpDays,
  projectSpendGrid,
  projectTasksInWindow,
  type WindowIntervalRow,
} from './task-projections.ts'

test('machine day contributions sum local work and take greatest git figures', () => {
  const base = {
    day: '2026-10-11',
    cache_read: 2,
    messages: 3,
    canon_tokens: 4,
    other_tokens: 5,
    commits: 6,
    files: 7,
    lines_product: 8,
    lines_test: 9,
    lines_docs: 10,
    lines_config: 11,
    lines_generated: 12,
  }
  expect(
    combineMachineDays([
      { ...base, claude_tokens: 100, tasks: 5, collected_at: '2026-10-11T10:00:00.000Z' },
      {
        ...base,
        claude_tokens: 200,
        cache_read: 20,
        tasks: 4,
        commits: 4,
        files: 5,
        collected_at: '2026-10-11T11:00:00.000Z',
      },
      {
        ...base,
        day: '2026-10-10',
        claude_tokens: 50,
        tasks: 2,
        collected_at: '2026-10-10T11:00:00.000Z',
      },
      {
        ...base,
        day: '2026-10-10',
        claude_tokens: 25,
        tasks: 1,
        collected_at: '2026-10-10T10:00:00.000Z',
      },
    ]),
  ).toEqual([
    {
      ...base,
      day: '2026-10-10',
      claude_tokens: 75,
      cache_read: 4,
      messages: 6,
      canon_tokens: 8,
      other_tokens: 10,
      tasks: 2,
      collected_at: '2026-10-10T11:00:00.000Z',
    },
    {
      ...base,
      claude_tokens: 300,
      cache_read: 22,
      messages: 6,
      canon_tokens: 8,
      other_tokens: 10,
      tasks: 5,
      collected_at: '2026-10-11T11:00:00.000Z',
    },
  ])
  expect(
    combineMachineDays([
      { ...base, claude_tokens: 100, tasks: 5, collected_at: '2026-10-11T10:00:00.000Z' },
    ]),
  ).toHaveLength(1)
})

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

function boardRow(
  overrides: Partial<BoardSourceRow> & Pick<BoardSourceRow, 'key'>,
): BoardSourceRow {
  return {
    project: 'workshop',
    title: overrides.key,
    assignee: null,
    status: 'active',
    status_category: 'active',
    source: 'local',
    updated_at: '2026-09-17T12:00:00.000Z',
    last_seen: '2026-09-17T12:00:00.000Z',
    ...overrides,
  }
}

test("a filtered project still receives done rows that would fall below the cap behind another project's rows", () => {
  const cap = 3
  const rows = [
    boardRow({ key: 'DEV-1', updated_at: '2026-09-17T12:00:00.000Z' }),
    boardRow({ key: 'DEV-2', updated_at: '2026-09-17T11:00:00.000Z' }),
    boardRow({ key: 'DEV-3', updated_at: '2026-09-17T10:00:00.000Z' }),
    boardRow({
      key: 'SEGNA-1',
      project: 'segnavia',
      status: 'done',
      status_category: 'done',
      source: 'mcp',
      updated_at: '2026-09-01T00:00:00.000Z',
    }),
  ]
  const recentKeys = ['unattributed:segnavia:SEGNA-1']
  const input = { rows, recentKeys, liveKeys: [] as string[], projects: project, cap }
  const unfiltered = projectBoard(input)
  const filtered = projectBoard({ ...input, filters: { project: 'segnavia', source: '' } })
  expect(unfiltered.cards.map((card) => card.key)).toEqual(['DEV-1', 'DEV-2', 'DEV-3'])
  expect(filtered.cards.map((card) => card.key)).toEqual(['SEGNA-1'])
  expect(filtered.totals).toEqual(unfiltered.totals)
  expect(Object.keys(filtered.totals.project).sort()).toEqual(['segnavia', 'workshop'])
})

test('the unfiltered board still caps at the cap', () => {
  const rows = [1, 2, 3, 4, 5].map((n) =>
    boardRow({ key: `DEV-${n}`, updated_at: `2026-09-17T1${n}:00:00.000Z` }),
  )
  const board = projectBoard({
    rows,
    recentKeys: [],
    liveKeys: [],
    projects: project,
    cap: 2,
    filters: { project: '', source: '' },
  })
  expect(board.cards).toHaveLength(2)
  expect(board.cap).toBe(2)
  expect(board.cards.map((card) => card.key)).toEqual(['DEV-5', 'DEV-4'])
  expect(board.totals.status.active).toBe(5)
})
