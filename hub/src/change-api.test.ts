import { expect, test } from 'bun:test'
import { changeApi } from './change-api.ts'

const config = {
  recordApiUrl: 'https://record.example.test',
  recordDatabaseUrl: 'postgres://unused',
}
const whoami = async () =>
  Response.json({
    user: { id: 'user-1' },
    activeSpaceId: 'space-a',
    memberships: [
      { space_id: 'space-a', slug: 'active', permission: 'write' },
      { space_id: 'space-b', slug: 'other', permission: 'write' },
    ],
  })
const request = (query: string, space = 'space-b') =>
  new Request(`https://hub.example.test/v1/changes?${query}`, {
    headers: { authorization: 'Bearer test', 'x-record-space': space },
  })

test('change route binds a requested member space and parses its bounded request', async () => {
  let received: unknown
  const response = await changeApi(request('after=0&tables=hub_task,hub_note'), config, {
    fetch: whoami,
    list: async (_url, identity, input) => {
      received = { identity, input }
      return { head: 0, oldest: null, next: 0, more: false, resetRequired: false, changes: [] }
    },
  })
  expect(response?.status).toBe(200)
  expect(received).toEqual({
    identity: {
      userId: 'user-1',
      spaceId: 'space-b',
      spaceIds: ['space-a', 'space-b'],
      memberships: [
        { spaceId: 'space-a', slug: 'active', permission: 'write' },
        { spaceId: 'space-b', slug: 'other', permission: 'write' },
      ],
    },
    input: { after: 0, limit: 500, tables: ['hub_task', 'hub_note'] },
  })
})

test('change route refuses non-members before reading and validates every query boundary', async () => {
  let reads = 0
  const dependencies = {
    fetch: whoami,
    list: async () => {
      reads++
      return { head: 0, oldest: null, next: 0, more: false, resetRequired: false, changes: [] }
    },
  }
  expect(
    (await changeApi(request('after=0&tables=hub_task', 'outside'), config, dependencies))?.status,
  ).toBe(403)
  expect(reads).toBe(0)

  for (const query of [
    'tables=hub_task',
    'after=-1&tables=hub_task',
    'after=9007199254740992&tables=hub_task',
    'after=0',
    'after=0&tables=',
    'after=0&tables=hub_interval',
    'after=0&tables=hub_task&tables=hub_note',
    'after=0&tables=hub_task&limit=0',
    'after=0&tables=hub_task&limit=501',
    'after=0&tables=hub_task&limit=1.5',
  ]) {
    const response = await changeApi(request(query), config, dependencies)
    expect(response?.status, query).toBe(400)
  }
  expect(reads).toBe(0)
  const invalidTable = await changeApi(request('after=0&tables=hub_interval'), config, dependencies)
  expect(await invalidTable?.json()).toEqual({
    error:
      'tables must name only: hub_task, hub_task_comment, hub_task_document, hub_task_status_event, hub_send, hub_note, hub_note_acknowledgement',
  })
})
