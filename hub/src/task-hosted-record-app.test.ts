import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PGlite } from '@electric-sql/pglite'
import { createNoDestinationWriteCounter } from '../../shared/record-no-destination-write-counter.ts'
import { forgetRecordSessionToken, writeRecordSessionToken } from '../../shared/record-session.ts'
import { createHostedRecordFixture, pgliteSql } from '../../orchestrator/test/fixtures/hosted-record.ts'
import { declareFixtureProjectSpace } from '../test/fixture-project-space.ts'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db } from './db.ts'
import { applyHostedPushChanges } from './hosted-push-changes.ts'
import { listHostedTasks } from './hosted-task-list.ts'
import { createHostedTask, getHostedTask } from './hosted-tasks.ts'
import { hostedRequestHandler } from './hosted.ts'
import { projectRecordIdFor } from './project-record-id.ts'
import { createTask, showTask } from './task.ts'

const spaceId = '01990000-0000-7000-8000-000000002520'
const userId = '01990000-0000-7000-8000-000000002521'
const projectId = projectRecordIdFor('gamma')
const stateRoot = mkdtempSync(join(tmpdir(), 'bottega-task-record-app-'))
const previous = {
  fetch: globalThis.fetch,
  hostedUrl: process.env.BOTTEGA_HOSTED_URL,
  keyStore: process.env.BOTTEGA_KEYSTORE,
  nodeEnv: process.env.NODE_ENV,
  stateHome: process.env.BOTTEGA_STATE_HOME,
}
let database: PGlite

declareFixtureProjectSpace('gamma', 'declared-gamma-space')

beforeAll(async () => {
  database = await createHostedRecordFixture({ spaceId, userId })
  await database.exec(`
    RESET ROLE;
    UPDATE space SET slug='declared-gamma-space' WHERE id='${spaceId}';
    INSERT INTO project (id,space_id,name,key_prefixes,created_at)
    VALUES ('${projectId}','${spaceId}','gamma',ARRAY['GAM'],now());
    SET ROLE record_actor;
  `)
  const client = pgliteSql(database)
  const identityFetch = async () =>
    Response.json({
      user: { id: userId, name: 'Record author' },
      activeSpaceId: spaceId,
      memberships: [
        { space_id: spaceId, slug: 'declared-gamma-space', permission: 'write' },
      ],
    })
  const handler = hostedRequestHandler(
    {
      recordApiUrl: 'https://record.example.test',
      recordDatabaseUrl: client,
      noDestinationWriteCounter: createNoDestinationWriteCounter(),
    },
    {
      tasks: {
        fetch: identityFetch,
        create: createHostedTask,
        get: getHostedTask,
        list: listHostedTasks,
      },
      changes: { fetch: identityFetch, push: applyHostedPushChanges },
    },
  )
  const appFetch = (input: string | URL | Request, init?: RequestInit) =>
    handler(new Request(input, init))
  globalThis.fetch = appFetch as typeof fetch
  process.env.BOTTEGA_HOSTED_URL = 'https://hub.example.test'
  process.env.BOTTEGA_KEYSTORE = 'file'
  process.env.BOTTEGA_STATE_HOME = stateRoot
  delete process.env.NODE_ENV
  writeRecordSessionToken('test')
})

beforeEach(resetFixtureStore)

afterAll(async () => {
  if (database) await database.close()
  globalThis.fetch = previous.fetch
  for (const [name, value] of [
    ['BOTTEGA_HOSTED_URL', previous.hostedUrl],
    ['BOTTEGA_KEYSTORE', previous.keyStore],
    ['BOTTEGA_STATE_HOME', previous.stateHome],
    ['NODE_ENV', previous.nodeEnv],
  ] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  forgetRecordSessionToken()
  rmSync(stateRoot, { recursive: true, force: true })
})

test('a hosted write is immediately readable from a fresh empty local store without pull', async () => {
  const created = await createTask(
    { project: 'gamma', title: 'Record-authoritative acceptance' },
    {
      hosted: {
        baseUrl: 'https://hub.example.test',
        token: 'test',
        fetch: globalThis.fetch as (input: string, init?: RequestInit) => Promise<Response>,
      },
    },
  )

  resetFixtureStore()
  expect(dbTaskCount()).toBe(0)

  const shown = await showTask(created.key, { project: 'gamma' })
  expect(shown.task).toMatchObject({
    record_id: created.record_id,
    key: created.key,
    project: 'gamma',
    title: 'Record-authoritative acceptance',
  })
  expect(dbTaskCount()).toBe(0)
})

function dbTaskCount(): number {
  return db().query<{ count: number }, []>('SELECT count(*) count FROM task').get()!.count
}
