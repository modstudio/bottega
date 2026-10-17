import { expect, test } from 'bun:test'
import type { Measures } from './measures.ts'
import { hostedTaskDetailFromRows, localTaskDetail, taskBodyVersion } from './task-detail.ts'

const capabilities = {
  setTitle: { allowed: true as const },
  setStatus: { allowed: true as const },
  setBody: { allowed: true as const },
  comment: { allowed: true as const },
  documents: { allowed: true as const },
  statusVocabulary: ['open'],
}

const base = {
  task: {
    record_id: 'task-1',
    key: 'DEV-1',
    project: 'workshop',
    title: 'Detail',
    status: 'open',
    status_category: 'open',
    parent_key: null,
    body: 'Body',
    assignee: null,
    source: 'local',
    updated_at: '2026-10-16T12:00:00.000Z',
  },
  comments: [{ id: 'comment-1', body: 'Note', created_at: '2026-10-16T11:00:00.000Z' }],
  documents: [],
  statusEvents: [
    {
      id: 'event-1',
      at: '2026-10-16T10:00:00.000Z',
      from_status: null,
      to_status: 'open',
    },
  ],
}

test('local task rows map to the shared detail contract', () => {
  const detail = localTaskDetail({
    ...base,
    capabilities,
    runs: [
      {
        id: 42,
        agent: 'codex',
        job: 'implementation',
        started_at: '2026-10-16T10:00:00.000Z',
        ended_at: '2026-10-16T11:00:00.000Z',
        running: false,
      },
    ],
  })
  expect(detail.task).toMatchObject({ recordId: 'task-1', statusCategory: 'open' })
  expect(detail.bodyVersion).toBe(taskBodyVersion('Body'))
  expect(detail.comments[0]?.createdAt).toBe('2026-10-16T11:00:00.000Z')
  expect(detail.runs[0]).toMatchObject({ id: '42', startedAt: '2026-10-16T10:00:00.000Z' })
  expect(detail.measures).toBeNull()
})

test('hosted task rows map absent bodies and intervals to shared runs', () => {
  const measures: Measures = {
    scope: 'space' as const,
    hoursRunning: {
      unionMs: 0,
      notAdditive: true,
      sample: { intervalCount: 0 },
      from: { startedIntervals: 0, sessionIntervals: 0 },
    },
    agentHours: {
      from: 'started' as const,
      sumMs: 0,
      sample: { intervalCount: 0 },
      unknownShare: { intervalCount: 0, sumMs: 0 },
    },
    sessionTime: {
      from: 'session' as const,
      unionThenSumMs: 0,
      uncountedSilenceMs: 0,
      sample: { intervalCount: 0, userCount: 0 },
      silenceAllowanceMs: 0,
      silenceAllowanceSentence: '',
      unknownUser: { unionThenSumMs: 0, uncountedSilenceMs: 0, sample: { intervalCount: 0 } },
    },
    cost: {
      from: 'started' as const,
      vendorCostUsd: 0,
      vendorTokens: 0,
      sample: { intervalCount: 0 },
      unknownShare: { vendorCostUsd: 0, vendorTokens: 0, intervalCount: 0 },
    },
    shipped: { count: 0, sample: { taskCount: 0, eventCount: 0 } },
  }
  const detail = hostedTaskDetailFromRows({
    ...base,
    task: { ...base.task, id: 'task-1', space_name: 'Team', body: null },
    runs: [
      {
        id: null,
        source: 'orch',
        agent: 'codex',
        job: 'implementation',
        start_at: '2026-10-16T10:00:00.000Z',
        end_at: '2026-10-16T11:00:00.000Z',
        open: 1,
      },
    ],
    measures,
    measureCoverage: { hasRecordedTime: true, from: 'a', to: 'b' },
  })
  expect(detail.task).toMatchObject({ body: null, spaceName: 'Team' })
  expect(detail.bodyVersion).toBe(taskBodyVersion(null))
  expect(detail.runs).toEqual([
    expect.objectContaining({
      id: null,
      agent: 'codex',
      startedAt: '2026-10-16T10:00:00.000Z',
      running: true,
    }),
  ])
  expect(detail.capabilities.setBody).toEqual({
    allowed: false,
    reason: 'The hosted record does not accept task writes from the dashboard.',
  })
})
