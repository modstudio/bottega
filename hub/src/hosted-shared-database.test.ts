import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
import { PLATFORM_NAME } from '../../shared/brand.ts'
import { createHostedRecordFixture, pgliteSql } from '../test/hosted-record-fixture.ts'
import { hostedRequestHandler } from './hosted.ts'
import { listHostedTasks } from './hosted-tasks.ts'

const spaceA = '01990000-0000-7000-8000-000000001401'
const spaceB = '01990000-0000-7000-8000-000000001402'
const userA = '01990000-0000-7000-8000-000000001403'
const userB = '01990000-0000-7000-8000-000000001404'
let database: PGlite

beforeAll(async () => {
  database = await createHostedRecordFixture({ spaceId: spaceA, userId: userA })
  await database.exec(`
    RESET ROLE;
    INSERT INTO space (id,name,slug,created_at)
    VALUES ('${spaceB}','Shared client B','shared-client-b',now());
    INSERT INTO "user" (id,email,name,created_at)
    VALUES ('${userB}','shared-b@example.test','Shared B',now());
    INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
    VALUES ('01990000-0000-7000-8000-000000001405','${spaceB}','${userB}','member','write',now());
    INSERT INTO hub_task
      (id,space_id,project_name,key,project,title,source,first_seen,last_seen,created_at,updated_at)
    VALUES
      ('01990000-0000-7000-8000-000000001406','${spaceA}','${PLATFORM_NAME}','DEV-1401-A','${PLATFORM_NAME}','User A task','local',now(),now(),now(),now()),
      ('01990000-0000-7000-8000-000000001407','${spaceB}','${PLATFORM_NAME}','DEV-1401-B','${PLATFORM_NAME}','User B task','local',now(),now(),now(),now());
    SET ROLE record_actor;
  `)
})

afterAll(async () => {
  if (database) await database.close()
})

test('consecutive hosted requests bind each user on one shared database client', async () => {
  const client = pgliteSql(database)
  const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const authorization = new Headers(init?.headers).get('authorization')
    const second = authorization === 'Bearer user-b'
    const userId = second ? userB : userA
    const spaceId = second ? spaceB : spaceA
    return Response.json({
      user: { id: userId },
      activeSpaceId: spaceId,
      memberships: [{ space_id: spaceId, permission: 'write' }],
    })
  }
  const handler = hostedRequestHandler(
    { recordApiUrl: 'https://record.example.test', recordDatabaseUrl: client },
    {
      tasks: {
        fetch: fetch as typeof globalThis.fetch,
        list: async (received, identity, filters) => {
          expect(received).toBe(client)
          return listHostedTasks(received, identity, filters)
        },
      },
    },
  )
  const request = (authorization: string) =>
    handler(
      new Request('https://hub.example.test/v1/tasks', {
        headers: { authorization },
      }),
    ).then((response) => response.json() as Promise<{ tasks: { key: string }[] }>)

  expect((await request('Bearer user-a')).tasks.map((task) => task.key)).toEqual(['DEV-1401-A'])
  expect((await request('Bearer user-b')).tasks.map((task) => task.key)).toEqual(['DEV-1401-B'])
})
