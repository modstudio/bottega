import { expect, test } from 'bun:test'
import { QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { HostedMessagesPage, MessagesContent } from '@/routes/messages'
import { queryClient, trpc } from '@/trpc/client'

const origin = {
  kind: 'operator',
  session: null,
  harness: null,
  project: null,
  runId: null,
}

test('messages render notice reach and question replies from the preloaded list', () => {
  queryClient.setQueryData(trpc.board.list.queryOptions({}).queryKey, {
    messages: [
      {
        id: '1',
        kind: 'notice',
        title: 'Release notice',
        audience: 'project:workshop',
        origin,
        senderTags: [],
        createdAt: '2026-10-05T12:00:00.000Z',
        expiresAt: null,
        withdrawnAt: null,
        ackRequired: true,
        ackDeadline: null,
        state: 'open',
        reached: 3,
        acknowledged: 2,
        unacknowledged: ['session-c'],
        store: 'local',
      },
      {
        id: '2',
        kind: 'question',
        title: 'Which release?',
        audience: 'architects',
        origin,
        senderTags: [],
        createdAt: '2026-10-05T11:00:00.000Z',
        expiresAt: null,
        withdrawnAt: null,
        ackRequired: false,
        ackDeadline: null,
        state: 'open',
        reached: 1,
        acknowledged: 0,
        unacknowledged: [],
        store: 'local',
        replyCount: 2,
        acceptedReplyId: null,
      },
    ],
    warning: null,
  })
  const html = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MessagesContent onOpen={() => {}} />
    </QueryClientProvider>,
  )
  expect(html).toContain('Release notice')
  expect(html).toContain('2 of 3 acknowledged')
  expect(html).toContain('Which release?')
  expect(html).toContain('2 replies · no answer accepted')
})

test('messages distinguish hosted reach from a local no-reach notice', () => {
  queryClient.setQueryData(trpc.board.list.queryOptions({}).queryKey, {
    messages: [
      {
        id: '3',
        kind: 'notice',
        title: 'Hosted notice',
        audience: 'architects',
        origin,
        senderTags: [],
        createdAt: '2026-10-05T12:00:00.000Z',
        expiresAt: null,
        withdrawnAt: null,
        ackRequired: false,
        ackDeadline: null,
        state: 'open',
        reached: null,
        acknowledged: null,
        unacknowledged: null,
        store: 'hosted',
      },
      {
        id: '4',
        kind: 'notice',
        title: 'Quiet notice',
        audience: 'session:missing',
        origin,
        senderTags: [],
        createdAt: '2026-10-05T12:00:00.000Z',
        expiresAt: null,
        withdrawnAt: null,
        ackRequired: false,
        ackDeadline: null,
        state: 'open',
        reached: 0,
        acknowledged: 0,
        unacknowledged: [],
        store: 'local',
      },
    ],
    warning: null,
  })
  const html = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MessagesContent onOpen={() => {}} />
    </QueryClientProvider>,
  )
  expect(html).toContain('Reach unknown')
  expect(html).toContain('Reached no session')
})

test('hosted messages route explains that the page is unavailable', () => {
  const html = renderToStaticMarkup(<HostedMessagesPage />)
  expect(html).toContain('The messages page is not available in the hosted hub yet.')
})
