import { beforeEach, expect, test } from 'bun:test'
import type { TrackerTask } from '../../../shared/trackers.ts'
import { declareFixtureProjectSpace } from '../../test/fixture-project-space.ts'
import { resetFixtureStore } from '../../test/run-fixtures.ts'
import { db, writeTransaction } from '../db.ts'
import { applyHostedCollectorPass, sendTrackerPlans } from './tracker-hosted-collector.ts'
import { type TrackerTaskRowPlan, trackerTaskRowPlan } from './tracker-row-plan.ts'
import { applyTrackerPlanOn, planTrackerTaskOn } from './trackers.ts'

declareFixtureProjectSpace('fixture', 'fixture-space')

const at = '2026-11-22T12:00:00.000Z'
const tasks: TrackerTask[] = ['FIX-1', 'FIX-2'].map((key) => ({
  externalId: key,
  key,
  project: 'fixture',
  title: key,
  status: 'open',
  category: 'open',
  updatedAt: at,
  assignee: null,
}))

beforeEach(resetFixtureStore)

test('a rejected planned row stays local-unapplied while an accepted sibling applies', async () => {
  const applied: string[] = []
  const result = await applyHostedCollectorPass({
    source: {
      project: 'fixture',
      env: 'FIXTURE',
      supportsUpdatedSince: false,
      fetch: async () => ({ tasks: [], deletedKeys: [], complete: true }),
    },
    tasks,
    deletedKeys: [],
    backfillTasks: [],
    prefixes: [],
    at,
    options: {
      baseUrl: 'https://hub.example.test',
      token: 'test',
      fetch: async (_input, init) => {
        const changes = JSON.parse(String(init?.body)) as Array<{ id: string }>
        return Response.json(
          changes.map(({ id }, index) =>
            index === 0
              ? { id, status: 'rejected', reason: 'fixture conflict' }
              : { id, status: 'applied' },
          ),
        )
      },
    },
    ports: {
      conn: db(),
      planTask: (task) =>
        trackerTaskRowPlan({
          task,
          stored: null,
          effectiveKey: task.key,
          parentRecordId: null,
          at,
          projectRecordId: '01990000-0000-7000-8000-000000002583',
        }),
      applyPlans: (plans) => applied.push(...plans.map((plan) => plan.row.key)),
      inScope: () => true,
      prefix: (key) => key.split('-')[0]!,
    },
  })

  expect(applied).toEqual(['FIX-2'])
  expect(result.rejected).toHaveLength(1)
  expect(result.rejected[0]).toContain('fixture conflict')
})

test('an unchanged plan sends no request (mutation: dropping the change filter fails)', async () => {
  const inserted = trackerTaskRowPlan({
    task: tasks[0]!,
    stored: null,
    effectiveKey: tasks[0]!.key,
    parentRecordId: null,
    at,
    projectRecordId: '01990000-0000-7000-8000-000000002583',
  }).row
  let requests = 0
  await applyHostedCollectorPass({
    source: {
      project: 'fixture',
      env: 'FIXTURE',
      supportsUpdatedSince: false,
      fetch: async () => ({ tasks: [], deletedKeys: [], complete: true }),
    },
    tasks: [tasks[0]!],
    deletedKeys: [],
    backfillTasks: [],
    prefixes: [],
    at,
    options: {
      baseUrl: 'https://hub.example.test',
      token: 'test',
      fetch: async () => {
        requests++
        return Response.json([])
      },
    },
    ports: {
      conn: db(),
      planTask: (task) =>
        trackerTaskRowPlan({
          task,
          stored: inserted,
          effectiveKey: task.key,
          parentRecordId: null,
          at,
          projectRecordId: '01990000-0000-7000-8000-000000002583',
        }),
      applyPlans: () => {},
      inScope: () => true,
      prefix: (key) => key.split('-')[0]!,
    },
  })
  expect(requests).toBe(0)
})

test('an event rejection applies neither row and the next pass resends both stages', async () => {
  const stored = trackerTaskRowPlan({
    task: tasks[0]!,
    stored: null,
    effectiveKey: tasks[0]!.key,
    parentRecordId: null,
    at,
    projectRecordId: '01990000-0000-7000-8000-000000002583',
  }).row
  const requests: string[][] = []
  let rejectEvent = true
  const applied: TrackerTaskRowPlan[] = []
  const run = () =>
    applyHostedCollectorPass({
      source: {
        project: 'fixture',
        env: 'FIXTURE',
        supportsUpdatedSince: false,
        fetch: async () => ({ tasks: [], deletedKeys: [], complete: true }),
      },
      tasks: [{ ...tasks[0]!, status: 'active', category: 'active' }],
      deletedKeys: [],
      backfillTasks: [],
      prefixes: [],
      at,
      options: {
        baseUrl: 'https://hub.example.test',
        token: 'test',
        fetch: async (_input, init) => {
          const changes = JSON.parse(String(init?.body)) as Array<{ id: string; table: string }>
          requests.push(changes.map(({ table }) => table))
          return Response.json(
            changes.map(({ id, table }) =>
              rejectEvent && table === 'hub_task_status_event'
                ? { id, status: 'rejected', reason: 'fixture event refusal' }
                : { id, status: 'applied' },
            ),
          )
        },
      },
      ports: {
        conn: db(),
        planTask: (task) =>
          trackerTaskRowPlan({
            task,
            stored,
            effectiveKey: task.key,
            parentRecordId: null,
            at,
            projectRecordId: '01990000-0000-7000-8000-000000002583',
          }),
        applyPlans: (plans) => applied.push(...plans),
        inScope: () => true,
        prefix: (key) => key.split('-')[0]!,
      },
    })

  const refused = await run()
  expect(refused.rejected).toHaveLength(1)
  expect(applied).toHaveLength(0)
  rejectEvent = false
  await run()
  expect(applied).toHaveLength(1)
  expect(requests).toEqual([
    ['hub_task'],
    ['hub_task_status_event'],
    ['hub_task'],
    ['hub_task_status_event'],
  ])
})

test('sendTrackerPlans refuses a batch spanning two projects', async () => {
  const first = trackerTaskRowPlan({
    task: tasks[0]!,
    stored: null,
    effectiveKey: tasks[0]!.key,
    parentRecordId: null,
    at,
    projectRecordId: '01990000-0000-7000-8000-000000002583',
  })
  const second = trackerTaskRowPlan({
    task: { ...tasks[1]!, project: 'other' },
    stored: null,
    effectiveKey: tasks[1]!.key,
    parentRecordId: null,
    at,
    projectRecordId: '01990000-0000-7000-8000-000000002584',
  })
  await expect(sendTrackerPlans([first, second])).rejects.toThrow(
    'tracker plan batch spans more than one project: fixture and other',
  )
})

test('a collector transport failure leaves local tracker state and outbox unchanged', async () => {
  const before = {
    tasks: db().query('SELECT * FROM task').all(),
    events: db().query('SELECT * FROM task_status_event').all(),
    outbox: db().query('SELECT * FROM hosted_outbox').all(),
  }
  await expect(
    applyHostedCollectorPass({
      source: {
        project: 'fixture',
        env: 'FIXTURE',
        supportsUpdatedSince: false,
        fetch: async () => ({ tasks: [], deletedKeys: [], complete: true }),
      },
      tasks: [tasks[0]!],
      deletedKeys: [],
      backfillTasks: [],
      prefixes: [],
      at,
      options: {
        baseUrl: 'https://hub.example.test',
        token: 'test',
        fetch: async () => {
          throw new Error('fixture record unreachable; retry collection')
        },
      },
      ports: {
        conn: db(),
        planTask: (task) =>
          trackerTaskRowPlan({
            task,
            stored: null,
            effectiveKey: task.key,
            parentRecordId: null,
            at,
            projectRecordId: '01990000-0000-7000-8000-000000002583',
          }),
        applyPlans: () => {
          throw new Error('local apply ran before transport completed')
        },
        inScope: () => true,
        prefix: (key) => key.split('-')[0]!,
      },
    }),
  ).rejects.toThrow('fixture record unreachable; retry collection')
  expect(db().query('SELECT * FROM task').all()).toEqual(before.tasks)
  expect(db().query('SELECT * FROM task_status_event').all()).toEqual(before.events)
  expect(db().query('SELECT * FROM hosted_outbox').all()).toEqual(before.outbox)
})

test('one hosted pass sends and applies deletion, retirement, and backfill rows', async () => {
  writeTransaction((conn) => {
    const insert = conn.query(
      `INSERT INTO task
       (record_id,external_id,key,project,title,status,status_category,source,first_seen,last_seen,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    insert.run(
      '01990000-0000-7000-8000-000000002501',
      'deleted-1',
      'FIX-DELETE',
      'fixture',
      'Delete me',
      'open',
      'open',
      'mcp',
      at,
      at,
      at,
    )
    insert.run(
      '01990000-0000-7000-8000-000000002502',
      'retired-1',
      'OLD-RETIRE',
      'fixture',
      'Retire me',
      'active',
      'active',
      'mcp',
      at,
      at,
      at,
    )
  })
  const received: Array<Array<{ table: string; row: Record<string, unknown> }>> = []
  const result = await applyHostedCollectorPass({
    source: {
      project: 'fixture',
      env: 'FIXTURE',
      supportsUpdatedSince: false,
      fetch: async () => ({ tasks: [], deletedKeys: [], complete: true }),
    },
    tasks: [],
    deletedKeys: ['FIX-DELETE'],
    backfillTasks: [{ ...tasks[0]!, key: 'FIX-BACKFILL', externalId: 'backfill-1' }],
    prefixes: ['FIX'],
    at,
    options: {
      baseUrl: 'https://hub.example.test',
      token: 'test',
      fetch: async (_input, init) => {
        const changes = JSON.parse(String(init?.body)) as Array<{
          id: string
          table: string
          row: Record<string, unknown>
        }>
        received.push(changes)
        return Response.json(changes.map(({ id }) => ({ id, status: 'applied' })))
      },
    },
    ports: {
      conn: db(),
      planTask: (task) => planTrackerTaskOn(db(), task, at),
      applyPlans: (plans) =>
        writeTransaction((conn) => {
          for (const plan of plans) applyTrackerPlanOn(conn, plan)
        }),
      inScope: (key) => key.startsWith('FIX-'),
      prefix: (key) => key.split('-')[0]!,
    },
  })

  expect(result).toMatchObject({ retired: 1, deletions: { dropped: 1 }, backfill: { filled: 1 } })
  expect(received[0]!.map(({ row }) => [row.key, row.status_category])).toEqual([
    ['FIX-DELETE', 'dropped'],
    ['OLD-RETIRE', 'dropped'],
    ['FIX-BACKFILL', 'open'],
  ])
  expect(received[1]!.map(({ table }) => table)).toEqual(['hub_task_status_event'])
  expect(
    db()
      .query<{ key: string; status_category: string; retired_reason: string | null }, []>(
        `SELECT key,status_category,retired_reason FROM task ORDER BY key`,
      )
      .all(),
  ).toEqual([
    { key: 'FIX-BACKFILL', status_category: 'open', retired_reason: null },
    { key: 'FIX-DELETE', status_category: 'dropped', retired_reason: null },
    {
      key: 'OLD-RETIRE',
      status_category: 'dropped',
      retired_reason:
        "out of scope: key prefix OLD is not among fixture's declared key prefixes FIX",
    },
  ])
})
