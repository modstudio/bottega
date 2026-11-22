import { beforeEach, expect, test } from 'bun:test'
import type { TrackerTask } from '../../../shared/trackers.ts'
import { declareFixtureProjectSpace } from '../../test/fixture-project-space.ts'
import { resetFixtureStore } from '../../test/run-fixtures.ts'
import { db } from '../db.ts'
import { applyHostedCollectorPass } from './tracker-hosted-collector.ts'
import { trackerTaskRowPlan } from './tracker-row-plan.ts'

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
