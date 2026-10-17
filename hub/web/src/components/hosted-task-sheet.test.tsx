import { expect, test } from 'bun:test'
import { queryClient } from '@bottega/hub-data/client'
import type { TaskDetail, UseTaskResult } from '@bottega/hub-data/use-task'
import { QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { HostedTaskSheet } from './hosted-task-sheet'

test('hosted task detail renders all history without mutation controls', () => {
  const detail: TaskDetail = {
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
      updatedAt: '2026-09-17T12:00:00.000Z',
      spaceName: 'Workshop',
    },
    bodyVersion: 'body-version',
    comments: [{ id: 'comment', body: 'A comment', createdAt: '2026-09-17T11:00:00.000Z' }],
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
        id: 'event',
        at: '2026-09-17T12:00:00.000Z',
        fromStatus: 'active',
        toStatus: 'done',
      },
    ],
    runs: [
      {
        id: null,
        agent: 'codex',
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
  const result = { detail, error: null, actions: {} } as UseTaskResult
  const html = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <HostedTaskSheet taskKey="DEV-701" result={result} onClose={() => undefined} />
    </QueryClientProvider>,
  )
  expect(html).toContain('A comment')
  expect(html).toContain('DEV-701/3')
  expect(html).toContain('Status history')
  expect(html).toContain('Intervals')
  expect(html).toContain('No time was recorded for this task')
  expect(html).toContain('100 agent tokens')
  expect(html).not.toContain('Save document')
  expect(html).not.toContain('Add comment')
  expect(html).not.toContain('Task status')
})
