import { expect, test } from 'bun:test'
import { QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { queryClient, trpc } from '@/trpc/client'
import { HostedTaskSheet } from './hosted-task-sheet'

test('hosted task detail renders all history without mutation controls', () => {
  const options = trpc.record.task.queryOptions({ key: 'DEV-701' })
  queryClient.setQueryData(options.queryKey, {
    task: {
      key: 'DEV-701',
      project: 'workshop',
      title: 'Hosted work pages',
      status: 'done',
      status_category: 'done',
      parent_key: null,
      body: 'Read only body',
      assignee: null,
      source: 'local',
      updated_at: '2026-09-17T12:00:00.000Z',
    },
    comments: [{ id: 'comment', body: 'A comment', created_at: '2026-09-17T11:00:00.000Z' }],
    documents: [
      {
        id: 'document',
        role: null,
        title: 'Plan',
        body: 'Document body',
        version: 'v1',
        created_at: '2026-09-17T10:00:00.000Z',
        updated_at: '2026-09-17T10:00:00.000Z',
      },
    ],
    statusHistory: [
      {
        id: 'event',
        at: '2026-09-17T12:00:00.000Z',
        from_status: 'active',
        to_status: 'done',
      },
    ],
    intervals: [
      {
        task_key: 'DEV-701',
        project: 'workshop',
        source: 'orch',
        agent: 'codex',
        job: 'implementation',
        start_at: '2026-09-17T10:00:00.000Z',
        end_at: '2026-09-17T11:00:00.000Z',
        claude_tokens: 0,
        vendor_tokens: 100,
        vendor_cost_usd: null,
        open: 0,
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
  })
  const html = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <HostedTaskSheet taskKey="DEV-701" onClose={() => undefined} />
    </QueryClientProvider>,
  )
  expect(html).toContain('A comment')
  expect(html).toContain('Status history')
  expect(html).toContain('Intervals')
  expect(html).toContain('No time was recorded for this task')
  expect(html).not.toContain('Save document')
  expect(html).not.toContain('Add comment')
  expect(html).not.toContain('Task status')
})
