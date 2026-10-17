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
    source: 'mcp',
    source_protocol: 'workspace-mcp',
    updated_at: '2026-10-16T12:00:00.000Z',
  },
  comments: [{ id: 'comment-1', body: 'Note', created_at: '2026-10-16T11:00:00.000Z' }],
  documents: [
    {
      id: 'document-1',
      number: 3,
      label: 'DEV-1/doc/3',
      role: 'handoff',
      title: 'Handoff',
      body: 'Document body',
      version: 'document-version',
      updated_at: '2026-10-16T11:30:00.000Z',
    },
  ],
  statusEvents: [
    {
      id: 'event-1',
      at: '2026-10-16T10:00:00.000Z',
      from_status: null,
      to_status: 'open',
    },
    {
      id: 'event-2',
      at: '2026-10-16T10:30:00.000Z',
      from_status: 'open',
      to_status: 'active',
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
        source: 'orch',
        agent: 'codex',
        job: 'implementation',
        started_at: '2026-10-16T10:00:00.000Z',
        ended_at: '2026-10-16T11:00:00.000Z',
        running: false,
      },
    ],
  })
  expect(detail).toEqual({
    task: {
      key: 'DEV-1',
      recordId: 'task-1',
      project: 'workshop',
      title: 'Detail',
      status: 'open',
      statusCategory: 'open',
      parentKey: null,
      body: 'Body',
      assignee: null,
      source: 'mcp',
      sourceProtocol: 'workspace-mcp',
      updatedAt: '2026-10-16T12:00:00.000Z',
      spaceName: null,
    },
    bodyVersion: taskBodyVersion('Body'),
    comments: [{ id: 'comment-1', body: 'Note', createdAt: '2026-10-16T11:00:00.000Z' }],
    documents: [
      {
        id: 'document-1',
        number: 3,
        label: 'DEV-1/doc/3',
        role: 'handoff',
        title: 'Handoff',
        body: 'Document body',
        version: 'document-version',
        updatedAt: '2026-10-16T11:30:00.000Z',
      },
    ],
    statusEvents: [
      { id: 'event-1', at: '2026-10-16T10:00:00.000Z', fromStatus: null, toStatus: 'open' },
      {
        id: 'event-2',
        at: '2026-10-16T10:30:00.000Z',
        fromStatus: 'open',
        toStatus: 'active',
      },
    ],
    runs: [
      {
        id: '42',
        source: 'orch',
        agent: 'codex',
        job: 'implementation',
        startedAt: '2026-10-16T10:00:00.000Z',
        endedAt: '2026-10-16T11:00:00.000Z',
        running: false,
      },
    ],
    measures: null,
    measureCoverage: null,
    capabilities,
  })
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
    task: {
      ...base.task,
      id: 'task-1',
      space_name: 'Team',
      body: null,
      source: 'hosted',
      source_protocol: null,
    },
    runs: [
      {
        id: null,
        source: 'orch',
        agent: null,
        job: 'implementation',
        start_at: '2026-10-16T10:00:00.000Z',
        end_at: '2026-10-16T11:00:00.000Z',
        open: 1,
      },
    ],
    measures,
    measureCoverage: { hasRecordedTime: true, from: 'a', to: 'b' },
  })
  const refused = {
    allowed: false as const,
    reason: 'The hosted record does not accept task writes from the dashboard.',
  }
  expect(detail).toEqual({
    task: {
      key: 'DEV-1',
      recordId: 'task-1',
      project: 'workshop',
      title: 'Detail',
      status: 'open',
      statusCategory: 'open',
      parentKey: null,
      body: null,
      assignee: null,
      source: 'hosted',
      sourceProtocol: null,
      updatedAt: '2026-10-16T12:00:00.000Z',
      spaceName: 'Team',
    },
    bodyVersion: taskBodyVersion(null),
    comments: [{ id: 'comment-1', body: 'Note', createdAt: '2026-10-16T11:00:00.000Z' }],
    documents: [
      {
        id: 'document-1',
        number: 3,
        label: 'DEV-1/doc/3',
        role: 'handoff',
        title: 'Handoff',
        body: 'Document body',
        version: 'document-version',
        updatedAt: '2026-10-16T11:30:00.000Z',
      },
    ],
    statusEvents: [
      { id: 'event-1', at: '2026-10-16T10:00:00.000Z', fromStatus: null, toStatus: 'open' },
      {
        id: 'event-2',
        at: '2026-10-16T10:30:00.000Z',
        fromStatus: 'open',
        toStatus: 'active',
      },
    ],
    runs: [
      {
        id: null,
        source: 'orch',
        agent: null,
        job: 'implementation',
        startedAt: '2026-10-16T10:00:00.000Z',
        endedAt: '2026-10-16T11:00:00.000Z',
        running: true,
      },
    ],
    measures,
    measureCoverage: { hasRecordedTime: true, from: 'a', to: 'b' },
    capabilities: {
      setTitle: refused,
      setStatus: refused,
      setBody: refused,
      comment: refused,
      documents: refused,
      statusVocabulary: null,
    },
  })
})
