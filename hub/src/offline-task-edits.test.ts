import { afterAll, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { STATE_HOME_ENV } from '../../shared/state-directory.ts'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { writeTransaction } from './db.ts'
import { observeTrackerTask } from './ingest/trackers.ts'
import { drainHostedEditOutbox } from './offline-task-edits.ts'

beforeEach(resetFixtureStore)
afterAll(resetFixtureStore)

test('a delivery-off drain reports the edit as queued with the refusal reason', async () => {
  const queuedAt = '2026-10-11T12:00:00.000Z'
  observeTrackerTask(
    {
      externalId: 'tracker-fix-1',
      key: 'FIX-1',
      project: 'fixture',
      title: 'Queued locally',
      status: 'open',
      category: 'open',
      updatedAt: null,
      assignee: null,
    },
    queuedAt,
    [],
  )
  const previousStateHome = process.env[STATE_HOME_ENV]
  const otherStateHome = mkdtempSync(join(tmpdir(), 'hub-offline-edit-non-installation-'))
  const messages: string[] = []
  const error = spyOn(console, 'error').mockImplementation((message) =>
    messages.push(String(message)),
  )
  process.env[STATE_HOME_ENV] = otherStateHome
  try {
    const result = await drainHostedEditOutbox(queuedAt)
    expect(result).toEqual({
      kind: 'queued',
      reason: expect.stringContaining('not the installation store'),
    })
    expect(messages).toEqual([
      expect.stringContaining('hosted change saved and queued: hosted delivery is off'),
    ])
  } finally {
    error.mockRestore()
    if (previousStateHome === undefined) delete process.env[STATE_HOME_ENV]
    else process.env[STATE_HOME_ENV] = previousStateHome
    rmSync(otherStateHome, { recursive: true, force: true })
  }
})

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
    [],
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
    [],
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
