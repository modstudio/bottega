import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { createHostedRecordFixture, pgliteSql } from '../../test/fixtures/hosted-record.ts'
import {
  createMemoryRecordApiClient,
  idleRecordApiDeps,
  idleSubjectDeps,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { recordApiTestApp } from '../../test/fixtures/record-api-app.ts'
import { projectCommand } from '../project/project-commands.ts'
import { upsertProject } from '../project/projects.ts'
import { rememberHostedRecord } from './install-binding-write.ts'
import { recordApiError } from './record-api-client-error.ts'
import type { RecordIdentity } from './record-auth.ts'
import { hostedProjectColumns } from './record-project-columns.ts'
import {
  mapRecordProjectRow,
  type RecordProjectUpsertInput,
  retireHostedProjectRow,
  upsertHostedProjectRow,
} from './record-projects.ts'

const spaceId = '01990000-0000-7000-8000-000000002200'
const userId = '01990000-0000-7000-8000-000000002201'
const projectId = '01990000-0000-7000-8000-000000002202'
const retirementProjectId = '01990000-0000-7000-8000-000000002203'
let database: PGlite

beforeAll(async () => {
  database = await createHostedRecordFixture({ spaceId, userId })
})

afterAll(async () => {
  if (database) await database.close()
})

function recordApp() {
  const sql = pgliteSql(database)
  const identity: RecordIdentity = {
    user: { id: userId, email: 'project-revision@example.test' },
    activeSpaceId: spaceId,
    personalSpaceId: spaceId,
    memberships: [
      {
        space_id: spaceId,
        name: 'Project revision',
        slug: 'project-revision',
        role: 'owner',
        permission: 'write',
      },
    ],
  }
  return recordApiTestApp(
    identity,
    { ...idleSubjectDeps(), ...idleRecordApiDeps() },
    {
      readProjects: async () => {
        const rows = await database.query<Record<string, unknown>>(
          'SELECT p.*,s.name AS space_name FROM project p JOIN space s ON s.id=p.space_id',
        )
        return rows.rows.map(mapRecordProjectRow)
      },
      upsertProject: async (input: RecordProjectUpsertInput & { spaceId: string }) => {
        const written = await upsertHostedProjectRow(sql, {
          ...input,
          columns: hostedProjectColumns(input.settings, input.name),
        })
        return { ...written, name: input.name }
      },
      retireProject: (input: { spaceId: string; id: string }) => retireHostedProjectRow(sql, input),
    },
  )
}

function projectBody(name: string, expectedRevision?: number, id = projectId): string {
  return JSON.stringify({
    id,
    name,
    path: '/w/project-revision',
    stack: null,
    canon: false,
    settings: {},
    retiredAt: null,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  })
}

function putProject(
  application: ReturnType<typeof recordApp>,
  name: string,
  expectedRevision?: number,
  id?: string,
) {
  return application.request('/v1/projects', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-record-space': spaceId },
    body: projectBody(name, expectedRevision, id),
  })
}

async function runProjectSet(name: string): Promise<void> {
  await projectCommand(
    'set',
    ['project', 'set', name],
    { has: () => false, flag: () => undefined },
    { log: () => {}, cwd: () => process.cwd() },
    { requireSpaceMembership: async () => {} },
  )
}

test('the real record app refuses a stale project revision and names the pull remedy', async () => {
  const application = recordApp()
  expect(await (await putProject(application, 'project-revision')).json()).toEqual({
    id: projectId,
    name: 'project-revision',
    revision: 1,
  })
  const read = (await (await application.request('/v1/projects')).json()) as Array<{
    revision: number
  }>
  expect(read[0]?.revision).toBe(1)

  expect(
    await (await putProject(application, 'newer-project', read[0]!.revision)).json(),
  ).toMatchObject({ revision: 2 })
  const stale = await putProject(application, 'stale-project', read[0]!.revision)
  expect(stale.status).toBe(409)
  const staleBody = await stale.json()
  expect(staleBody).toEqual({
    error:
      `project ${projectId} changed since revision 1; now 2.\n` +
      `cleared by: ${PLATFORM_SLUG} record sync`,
    code: 'revision-conflict',
    reason: 'stale-revision',
    condition: `project ${projectId} changed since revision 1; now 2.`,
    currentRevision: '2',
  })
  expect(recordApiError(staleBody, stale.status)).toMatchObject({
    kind: 'conflict',
    currentRevision: '2',
  })
  expect(
    (await database.query<{ name: string }>('SELECT name FROM project WHERE id=$1', [projectId]))
      .rows,
  ).toEqual([{ name: 'newer-project' }])
})

test('project set refuses after another machine writes a newer project revision', async () => {
  const application = recordApp()
  const id = newRecordId()
  const created = (await (await putProject(application, 'set-stale', undefined, id)).json()) as {
    revision: number
  }
  upsertProject({
    recordId: id,
    recordRevision: created.revision,
    name: 'set-stale',
    path: '/w/set-stale',
    settings: { space: 'project-revision' },
  })
  await putProject(application, 'set-newer', created.revision, id)
  rememberHostedRecord()
  const priorApiUrl = process.env.BOTTEGA_RECORD_API_URL
  process.env.BOTTEGA_RECORD_API_URL = 'https://record-api.example.test'
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    whoami: async () => ({
      user: { id: userId },
      activeSpaceId: spaceId,
      personalSpaceId: spaceId,
      memberships: [{ space_id: spaceId, slug: 'project-revision', permission: 'write' as const }],
    }),
    upsertProject: async (input) => {
      const response = await application.request('/v1/projects', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-record-space': spaceId },
        body: JSON.stringify(input),
      })
      const body = await response.json()
      if (!response.ok) throw recordApiError(body, response.status)
      return body as { id: string; name: string; revision: number }
    },
  })
  try {
    await expect(runProjectSet('set-stale')).rejects.toMatchObject({
      kind: 'conflict',
      currentRevision: String(created.revision + 1),
      message: expect.stringContaining(`${PLATFORM_SLUG} record sync`),
    })
  } finally {
    installRecordApiClient(createMemoryRecordApiClient())
    if (priorApiUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
    else process.env.BOTTEGA_RECORD_API_URL = priorApiUrl
  }
})

test('retire returns the revision used by a same-machine unretire and preserves stale refusal', async () => {
  const application = recordApp()
  const created = (await (
    await putProject(application, 'retire-revision', undefined, retirementProjectId)
  ).json()) as { revision: number }
  const retire = await application.request(`/v1/projects/${retirementProjectId}/retire`, {
    method: 'POST',
    headers: { 'x-record-space': spaceId },
  })
  expect(await retire.json()).toEqual({ name: 'retire-revision', revision: created.revision + 1 })

  const unretired = (await (
    await putProject(application, 'retire-revision', created.revision + 1, retirementProjectId)
  ).json()) as { revision: number }
  expect(unretired.revision).toBe(created.revision + 2)

  const secondRetire = (await (
    await application.request(`/v1/projects/${retirementProjectId}/retire`, {
      method: 'POST',
      headers: { 'x-record-space': spaceId },
    })
  ).json()) as { revision: number }
  const anotherMachine = (await (
    await putProject(application, 'other-machine-write', secondRetire.revision, retirementProjectId)
  ).json()) as { revision: number }
  const staleUnretire = await putProject(
    application,
    'retire-revision',
    secondRetire.revision,
    retirementProjectId,
  )
  expect(anotherMachine.revision).toBe(secondRetire.revision + 1)
  expect(staleUnretire.status).toBe(409)
  expect(await staleUnretire.json()).toEqual({
    error:
      `project ${retirementProjectId} changed since revision ${secondRetire.revision}; now ${anotherMachine.revision}.\n` +
      `cleared by: ${PLATFORM_SLUG} record sync`,
    code: 'revision-conflict',
    reason: 'stale-revision',
    condition: `project ${retirementProjectId} changed since revision ${secondRetire.revision}; now ${anotherMachine.revision}.`,
    currentRevision: String(anotherMachine.revision),
  })
})
