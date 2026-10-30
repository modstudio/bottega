import { expect, test } from 'bun:test'
import { hostedRouteTestConfig } from '../test/hosted-route-fixture.ts'
import { changeApi } from './change-api.ts'
import { hostedPushChanges } from './task-client.ts'

const config = hostedRouteTestConfig
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
const idsRequest = (query: string, space = 'space-b') =>
  new Request(`https://hub.example.test/v1/changes/ids?${query}`, {
    headers: { authorization: 'Bearer test', 'x-record-space': space },
  })
const pushRequest = (body: unknown, space = 'space-b') =>
  new Request('https://hub.example.test/v1/changes', {
    method: 'POST',
    headers: {
      authorization: 'Bearer test',
      'content-type': 'application/json',
      'x-record-space': space,
    },
    body: JSON.stringify(body),
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
      kind: 'authenticated',
      userId: 'user-1',
      spaceId: 'space-b',
      spaceIds: ['space-a', 'space-b'],
      userName: null,
      memberships: [
        { spaceId: 'space-a', slug: 'active', permission: 'write' },
        { spaceId: 'space-b', slug: 'other', permission: 'write' },
      ],
    },
    input: { after: 0, limit: 500, tables: ['hub_task', 'hub_note'] },
  })
})

test('push route authorizes the requested space and refuses unaccepted tables', async () => {
  const at = '2026-10-11T12:00:00.000Z'
  const change = {
    table: 'hub_task_status_event' as const,
    id: '01990000-0000-7000-8000-000000000001',
    op: 'upsert' as const,
    row: {
      id: '01990000-0000-7000-8000-000000000001',
      task_key: 'DEV-1',
      task_id: null,
      project_name: 'workshop',
      at,
      from_status: 'open',
      to_status: 'active',
      created_at: at,
      updated_at: at,
      deleted_at: null,
    },
  }
  let received: unknown
  const response = await changeApi(pushRequest([change]), config, {
    fetch: whoami,
    push: async (_url, identity, body) => {
      received = { identity, body }
      return [{ id: change.id, status: 'applied' }]
    },
  })
  expect(response?.status).toBe(200)
  expect(received).toEqual({
    identity: expect.objectContaining({ spaceId: 'space-b' }),
    body: [
      {
        ...change,
        row: {
          ...change.row,
          actor_user_id: null,
          actor_name: null,
          agent: null,
          run_id: null,
        },
      },
    ],
  })

  const refused = await changeApi(pushRequest([{ ...change, table: 'hub_send' }]), config, {
    fetch: whoami,
    push: async () => [],
  })
  expect(refused?.status).toBe(200)
  expect(await refused?.json()).toEqual([
    {
      id: change.id,
      status: 'rejected',
      reason:
        'table hub_send is not accepted; accepted tables: hub_task, hub_task_status_event, hub_task_comment, hub_task_document, hub_interval, hub_day, hub_note, hub_note_acknowledgement',
    },
  ])
})

test('push route requires write membership', async () => {
  const readonlyWhoami = async () =>
    Response.json({
      user: { id: 'user-1' },
      activeSpaceId: 'space-a',
      memberships: [{ space_id: 'space-a', slug: 'active', permission: 'read' }],
    })
  let pushes = 0
  const response = await changeApi(pushRequest([], 'space-a'), config, {
    fetch: readonlyWhoami,
    push: async () => {
      pushes++
      return []
    },
  })
  expect(response?.status).toBe(403)
  expect(pushes).toBe(0)
})

test('push route rejects an invalid item in place and passes only validated rows to the handler', async () => {
  const at = '2026-10-11T12:00:00.000Z'
  const valid = {
    table: 'hub_task_status_event',
    id: '01990000-0000-7000-8000-000000000010',
    op: 'upsert',
    row: {
      id: '01990000-0000-7000-8000-000000000010',
      task_key: 'DEV-10',
      project_name: 'workshop',
      at,
      from_status: 'open',
      to_status: 'active',
      created_at: at,
      updated_at: at,
      deleted_at: null,
    },
  }
  const invalid = {
    ...valid,
    id: '01990000-0000-7000-8000-000000000011',
    row: { ...valid.row, id: 'different' },
  }
  let received: unknown
  const response = await changeApi(pushRequest([invalid, valid]), config, {
    fetch: whoami,
    push: async (_url, _identity, inputs) => {
      received = inputs
      return [{ id: valid.id, status: 'applied' }]
    },
  })
  expect(received).toEqual([
    {
      ...valid,
      row: {
        ...valid.row,
        actor_user_id: null,
        actor_name: null,
        agent: null,
        run_id: null,
      },
    },
  ])
  expect(await response?.json()).toEqual([
    {
      id: invalid.id,
      status: 'rejected',
      reason: 'hub_task_status_event upsert requires a row whose id matches the pointer',
    },
    { id: valid.id, status: 'applied' },
  ])
})

test('push route rejects malformed UUIDs and timestamps at their batch positions', async () => {
  const at = '2026-10-11T12:00:00.000Z'
  const valid = {
    table: 'hub_task_status_event',
    id: '01990000-0000-7000-8000-000000000020',
    op: 'upsert',
    row: {
      id: '01990000-0000-7000-8000-000000000020',
      task_key: 'DEV-20',
      task_id: '01990000-0000-7000-8000-000000000021',
      project_name: 'workshop',
      at,
      from_status: 'open',
      to_status: 'active',
      created_at: at,
      updated_at: at,
      deleted_at: null,
    },
  }
  const body = [
    { ...valid, id: 'not-a-uuid', row: { ...valid.row, id: 'not-a-uuid' } },
    { ...valid, row: { ...valid.row, task_id: 'not-a-uuid' } },
    { ...valid, row: { ...valid.row, at: 'yesterday' } },
    { table: valid.table, op: 'delete' },
    valid,
  ]
  let received: unknown
  const response = await changeApi(pushRequest(body), config, {
    fetch: whoami,
    push: async (_url, _identity, inputs) => {
      received = inputs
      return [{ id: valid.id, status: 'applied' }]
    },
  })
  expect(received).toEqual([
    {
      ...valid,
      row: {
        ...valid.row,
        actor_user_id: null,
        actor_name: null,
        agent: null,
        run_id: null,
      },
    },
  ])
  expect(await response?.json()).toEqual([
    {
      id: 'not-a-uuid',
      status: 'rejected',
      reason: 'pushed change id must be a UUID',
    },
    {
      id: valid.id,
      status: 'rejected',
      reason: 'hub_task_status_event row.task_id must be a UUID, null, or absent',
    },
    {
      id: valid.id,
      status: 'rejected',
      reason: 'hub_task_status_event row.at must be an ISO timestamp',
    },
    {
      id: '',
      status: 'rejected',
      reason: 'pushed change id must be a non-empty string',
    },
    { id: valid.id, status: 'applied' },
  ])
})

test('push client accepts one outcome per requested id and refuses a malformed set', async () => {
  const body = [{ table: 'hub_task_status_event' as const, id: 'event-one', op: 'delete' as const }]
  expect(
    await hostedPushChanges(body, {
      baseUrl: 'https://hub.example.test',
      token: 'session',
      recordSpace: 'space-a',
      fetch: async () => Response.json([{ id: 'event-one', status: 'applied' }]),
    }),
  ).toEqual([{ id: 'event-one', status: 'applied' }])
  const intervalId = '01990000-0000-7000-8000-000000001301'
  const replacedId = '01990000-0000-7000-8000-000000001300'
  expect(
    await hostedPushChanges([{ table: 'hub_interval', id: intervalId, op: 'delete' }], {
      baseUrl: 'https://hub.example.test',
      token: 'session',
      recordSpace: 'space-a',
      fetch: async () => Response.json([{ id: intervalId, status: 'applied', replacedId }]),
    }),
  ).toEqual([{ id: intervalId, status: 'applied', replacedId }])
  await expect(
    hostedPushChanges(body, {
      baseUrl: 'https://hub.example.test',
      token: 'session',
      fetch: async () => Response.json([]),
    }),
  ).rejects.toThrow('do not match the requested ids')
})

test('identity-set route binds the requested space and refuses a non-member before reading', async () => {
  let received: unknown
  const response = await changeApi(idsRequest('table=hub_task'), config, {
    fetch: whoami,
    ids: async (_url, identity, input) => {
      received = { identity, input }
      return { ids: [], more: false }
    },
  })
  expect(response?.status).toBe(200)
  expect(received).toEqual({
    identity: expect.objectContaining({ spaceId: 'space-b' }),
    input: { table: 'hub_task', after: null },
  })
  const paged = await changeApi(
    idsRequest('table=hub_interval&after=01990000-0000-7000-8000-000000000001'),
    config,
    {
      fetch: whoami,
      ids: async (_url, _identity, input) => {
        received = input
        return { ids: [], more: false }
      },
    },
  )
  expect(paged?.status).toBe(200)
  expect(received).toEqual({
    table: 'hub_interval',
    after: '01990000-0000-7000-8000-000000000001',
  })
  let reads = 0
  expect(
    (
      await changeApi(idsRequest('table=hub_task', 'outside'), config, {
        fetch: whoami,
        ids: async () => {
          reads++
          return { ids: [], more: false }
        },
      })
    )?.status,
  ).toBe(403)
  expect(reads).toBe(0)
  const invalid = await changeApi(idsRequest('table=hub_send'), config, {
    fetch: whoami,
    ids: async () => {
      reads++
      return { ids: [], more: false }
    },
  })
  expect(invalid?.status).toBe(400)
  expect(reads).toBe(0)
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
