import { beforeEach, expect, spyOn, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { writeTransaction } from './db.ts'
import { observeTrackerTask } from './ingest/trackers.ts'
import { drainHostedEditOutbox } from './offline-task-edits.ts'

beforeEach(resetFixtureStore)

test('a queued write reports its routing wait instead of another drainer', async () => {
  const queuedAt = '2026-10-11T12:00:00.000Z'
  observeTrackerTask(
    {
      externalId: 'tracker-ghost-1',
      key: 'GHO-1',
      project: 'missing',
      title: 'Missing project',
      status: 'open',
      category: 'open',
      updatedAt: null,
      assignee: null,
    },
    queuedAt,
  )
  const messages: string[] = []
  const error = spyOn(console, 'error').mockImplementation((message) =>
    messages.push(String(message)),
  )
  try {
    await drainHostedEditOutbox(queuedAt, {
      baseUrl: 'https://hub.example.test',
      token: 'test',
      fetch: async (input) => {
        const url = new URL(input)
        if (url.pathname === '/v1/tasks/identity')
          return Response.json({
            userId: 'user-one',
            activeSpaceId: 'space-one',
            memberships: [{ spaceId: 'space-one', slug: 'one', permission: 'write' }],
            capabilities: { spacePush: true, spacePushTables: ['hub_task'] },
          })
        throw new Error('an unroutable row must not be pushed')
      },
    })
  } finally {
    error.mockRestore()
  }
  expect(messages).toEqual([
    `hosted change saved and queued: waiting on routing: project "missing" is not registered; register it with ${PLATFORM_SLUG} project add <path>, or, if it is not a real project, note that such rows cannot be retired yet; inspect it with \`${PLATFORM_SLUG} record outbox\``,
  ])
})

test('a queued write reports its routing wait while the collector holds the lease', async () => {
  const queuedAt = '2026-10-11T12:00:00.000Z'
  observeTrackerTask(
    {
      externalId: 'tracker-ghost-1',
      key: 'GHO-1',
      project: 'missing',
      title: 'Missing project',
      status: 'open',
      category: 'open',
      updatedAt: null,
      assignee: null,
    },
    queuedAt,
  )
  writeTransaction((conn) =>
    conn
      .query(`INSERT INTO setting(key,value) VALUES ('hosted-outbox.lease',?)`)
      .run(JSON.stringify({ holder: 'outbox:collector', until: Date.now() + 60_000 })),
  )
  const messages: string[] = []
  const error = spyOn(console, 'error').mockImplementation((message) =>
    messages.push(String(message)),
  )
  try {
    await drainHostedEditOutbox(queuedAt, {
      baseUrl: 'https://hub.example.test',
      token: 'test',
      fetch: async (input) => {
        const url = new URL(input)
        if (url.pathname === '/v1/tasks/identity')
          return Response.json({
            userId: 'user-one',
            activeSpaceId: 'space-one',
            memberships: [{ spaceId: 'space-one', slug: 'one', permission: 'write' }],
            capabilities: { spacePush: true, spacePushTables: ['hub_task'] },
          })
        throw new Error('an unroutable row must not be pushed')
      },
    })
  } finally {
    error.mockRestore()
  }
  expect(messages).toEqual([
    `hosted change saved and queued: waiting on routing: project "missing" is not registered; register it with ${PLATFORM_SLUG} project add <path>, or, if it is not a real project, note that such rows cannot be retired yet; inspect it with \`${PLATFORM_SLUG} record outbox\``,
  ])
})
