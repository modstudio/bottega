import { expect, test } from 'bun:test'
import { queryClient } from '@bottega/hub-data/client'
import type { UseTaskResult } from '@bottega/hub-data/use-task'
import { QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { TaskScreen } from './task-screen'

test('a hosted task renders its history, documents and measures without edit controls', () => {
  const detail: NonNullable<UseTaskResult['detail']> = {
    task: {
      key: 'DEV-701',
      recordId: 'task-1',
      project: 'workshop',
      title: 'Hosted work pages',
      status: 'done',
      statusCategory: 'done',
      parentKey: null,
      body: 'Read only body',
      assignee: null,
      source: 'local',
      sourceProtocol: null,
      updatedAt: '2026-09-17T12:00:00.000Z',
      spaceName: 'Workshop',
    },
    bodyVersion: 'body-version',
    comments: [
      {
        id: 'comment',
        body: 'A comment',
        createdAt: '2026-09-17T11:00:00.000Z',
        updatedAt: '2026-09-17T11:00:00.000Z',
        actorName: null,
        agent: null,
        canEdit: false,
        canDelete: false,
      },
    ],
    documents: [
      {
        id: 'document',
        number: 3,
        label: 'DEV-701/3',
        role: null,
        title: 'Plan',
        body: 'Document body',
        version: 'v1',
        updatedAt: '2026-09-17T10:00:00.000Z',
      },
    ],
    statusEvents: [
      {
        id: 'event-older',
        at: '2026-09-17T11:00:00.000Z',
        fromStatus: 'open',
        toStatus: 'active',
        actorName: null,
        agent: null,
      },
      {
        id: 'event',
        at: '2026-09-17T12:00:00.000Z',
        fromStatus: 'active',
        toStatus: 'done',
        actorName: null,
        agent: null,
      },
    ],
    runs: [
      {
        id: null,
        source: 'orch',
        agent: null,
        job: 'implementation',
        startedAt: '2026-09-17T10:00:00.000Z',
        endedAt: '2026-09-17T11:00:00.000Z',
        running: false,
      },
    ],
    measures: {
      scope: 'space',
      hoursRunning: {
        notAdditive: true,
        unionMs: 3_600_000,
        sample: { intervalCount: 1 },
        from: { startedIntervals: 1, sessionIntervals: 0 },
      },
      agentHours: {
        from: 'started',
        sumMs: 3_600_000,
        sample: { intervalCount: 1 },
        unknownShare: { intervalCount: 1, sumMs: 3_600_000 },
      },
      sessionTime: {
        from: 'session',
        unionThenSumMs: 0,
        uncountedSilenceMs: 0,
        sample: { intervalCount: 0, userCount: 0 },
        silenceAllowanceMs: 600_000,
        silenceAllowanceSentence: 'Silences longer than ten minutes are not counted.',
        unknownUser: { unionThenSumMs: 0, uncountedSilenceMs: 0, sample: { intervalCount: 0 } },
      },
      cost: {
        from: 'started',
        vendorCostUsd: 0,
        vendorTokens: 100,
        sample: { intervalCount: 1 },
        unknownShare: { vendorCostUsd: 0, vendorTokens: 100, intervalCount: 1 },
      },
      shipped: { count: 1, sample: { taskCount: 1, eventCount: 1 } },
      cycleTime: { medianMs: 3_600_000, p90Ms: 3_600_000, n: 1 },
    },
    measureCoverage: {
      hasRecordedTime: false,
      from: '2026-09-17T10:00:00.000Z',
      to: '2026-09-17T12:00:00.001Z',
    },
    capabilities: {
      setTitle: { allowed: false, reason: 'Read only' },
      setStatus: { allowed: false, reason: 'Read only' },
      setBody: { allowed: false, reason: 'Read only' },
      comment: { allowed: false, reason: 'Read only' },
      documents: { allowed: false, reason: 'Read only' },
      statusVocabulary: null,
    },
  }
  const refused = {
    run: () => undefined,
    pending: false,
    error: null,
    refused: 'Read only',
    conflict: false,
    reload: () => undefined,
  }
  const result = {
    detail,
    error: null,
    actions: {
      setTitle: refused,
      setStatus: refused,
      setBody: refused,
      setDocument: refused,
      comment: refused,
      editComment: refused,
      deleteComment: refused,
    },
  } as unknown as UseTaskResult
  const html = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <TaskScreen
        taskKey="DEV-701"
        result={result}
        openDoc={null}
        onOpenDoc={() => undefined}
        onClose={() => undefined}
      />
    </QueryClientProvider>,
  )
  expect(html).toContain('A comment')
  expect(html).toContain('Plan')
  expect(html).toContain('aria-label="History"')
  expect(html).toContain(' · orch</span> · implementation')
  expect(html).toContain('Read only')
  expect(html).toContain('No time was recorded for this task')
  expect(html).toContain('100 agent tokens')
  expect(html).not.toContain('Edit</button>')
  expect(html).not.toContain('Add a comment')
  expect(html).not.toContain('Task status')
})
