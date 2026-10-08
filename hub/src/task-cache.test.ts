import { beforeEach, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import { pullHostedTasks } from './task-cache.ts'

const registered = [
  { name: 'one', settings: { space: 'one' } },
  { name: 'two', settings: { space: 'two' } },
  { name: 'refused', settings: { space: 'missing' } },
]

const emptyChanges = (cursor: string) => ({
  tasks: [],
  comments: [],
  documents: [],
  statusEvents: [],
  cursor,
})

const cursor = (key: string) =>
  db().query<{ value: string }, [string]>('SELECT value FROM setting WHERE key=?').get(key)
    ?.value ?? null

beforeEach(resetFixtureStore)

test('task pull requests every project destination and the distinct active space', async () => {
  writeTransaction((conn) => {
    const put = conn.query('INSERT INTO setting(key,value) VALUES (?,?)')
    put.run('collect.hosted-tasks.cursor', 'active-before')
    put.run('collect.hosted-tasks.cursor.space-one', 'one-before')
  })
  const requests: Array<{ space: string | null; cursor: string | null }> = []
  const fetch = async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    if (url.pathname === '/v1/tasks/identity')
      return Response.json({
        userId: 'user-1',
        activeSpaceId: 'space-active',
        memberships: [
          { spaceId: 'space-active', slug: 'active' },
          { spaceId: 'space-one', slug: 'one' },
          { spaceId: 'space-two', slug: 'two' },
        ],
      })
    const space = new Headers(init?.headers).get('x-record-space')
    requests.push({ space, cursor: url.searchParams.get('cursor') })
    return Response.json(emptyChanges(`${space}-after`))
  }

  await pullHostedTasks({
    baseUrl: 'https://hub.example.test',
    token: 'session',
    fetch,
    registeredProjects: registered,
  })

  expect(requests).toEqual([
    { space: 'space-active', cursor: 'active-before' },
    { space: 'space-one', cursor: 'one-before' },
    { space: 'space-two', cursor: null },
  ])
  expect(cursor('collect.hosted-tasks.cursor')).toBe('space-active-after')
  expect(cursor('collect.hosted-tasks.cursor.space-one')).toBe('space-one-after')
  expect(cursor('collect.hosted-tasks.cursor.space-two')).toBe('space-two-after')
})

test('a failed space keeps its cursor while every other space advances', async () => {
  writeTransaction((conn) => {
    const put = conn.query('INSERT INTO setting(key,value) VALUES (?,?)')
    put.run('collect.hosted-tasks.cursor.space-one', 'one-before')
  })
  const attempted: string[] = []
  const fetch = async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    if (url.pathname === '/v1/tasks/identity')
      return Response.json({
        userId: 'user-1',
        activeSpaceId: 'space-active',
        memberships: [
          { spaceId: 'space-active', slug: 'active' },
          { spaceId: 'space-one', slug: 'one' },
          { spaceId: 'space-two', slug: 'two' },
        ],
      })
    const space = new Headers(init?.headers).get('x-record-space')!
    attempted.push(space)
    if (space === 'space-one') return Response.json({ error: 'offline' }, { status: 503 })
    return Response.json(emptyChanges(`${space}-after`))
  }

  await expect(
    pullHostedTasks({
      baseUrl: 'https://hub.example.test',
      token: 'session',
      fetch,
      registeredProjects: registered,
    }),
  ).rejects.toThrow(
    'hosted task pulls failed: space-one: hosted hub refused the request (503): offline',
  )

  expect(attempted).toEqual(['space-active', 'space-one', 'space-two'])
  expect(cursor('collect.hosted-tasks.cursor')).toBe('space-active-after')
  expect(cursor('collect.hosted-tasks.cursor.space-one')).toBe('one-before')
  expect(cursor('collect.hosted-tasks.cursor.space-two')).toBe('space-two-after')
})
